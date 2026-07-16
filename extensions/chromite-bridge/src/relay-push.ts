// Relay push consumer — spec chromite-relay-push-consumer-v1 (Phase 1 of
// chromite-chat-backend-explore umbrella).
//
// When the buyer is shown a personal-QR payment card, subscribe the relay
// Phoenix socket topic `conv:<order_id>` (chromite manual_confirm dispatches
// with conv_id fallback = order_id). Consume server-pushed SystemNotification
// frames (chromite → gRPC → relay → WS), deliver them into the buyer's
// telegram chat, ack the frame, and leave the topic once the order is paid.
//
// RP-I1 (one-way): this module only ever sends Phoenix control events
// (phx_join / heartbeat / ack / phx_leave) — never an inbound business
// "frame". Writes go through the regular tool RPCs, not this channel.
// RP-I2 (dedupe): SystemNotification.event_id ring — replayed frames (relay
// resume_from_seq=0 rejoin) are acked but delivered at most once.
//
// The service is a side channel: every public entry point swallows its own
// errors (fail-visible via logger) so the buyer reply path never depends on
// relay availability.

import type { ClientAction } from "./projection-engine.js";

// ---------------------------------------------------------------------------
// Pure helpers: projection refs, Phoenix V2 wire codec, notification payload.
// ---------------------------------------------------------------------------

export type OrderRef = {
  orderId: string;
  paymentId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Extract `projection.entity.refs.{order_id, payment_id}` from an
 * `interaction_projection` v1 client action (pay.rs emits these as business
 * refs). Returns null when absent — callers must treat that as "no
 * subscription", never guess.
 */
export function extractOrderRef(clientActions: ClientAction[] | undefined): OrderRef | null {
  const action = (clientActions ?? []).find((a) => a.kind === "interaction_projection");
  if (!action || action.version !== 1 || !isRecord(action.projection)) {
    return null;
  }
  const entity = isRecord(action.projection.entity) ? action.projection.entity : {};
  const refs = isRecord(entity.refs) ? entity.refs : {};
  const orderId = readString(refs.order_id);
  if (!orderId) {
    return null;
  }
  return { orderId, paymentId: readString(refs.payment_id) };
}

/** Phoenix channels V2 wire message: [join_ref, ref, topic, event, payload]. */
export type PhoenixMessage = {
  joinRef: string | null;
  ref: string | null;
  topic: string;
  event: string;
  payload: unknown;
};

export function encodePhoenixMessage(msg: PhoenixMessage): string {
  return JSON.stringify([msg.joinRef, msg.ref, msg.topic, msg.event, msg.payload]);
}

export function decodePhoenixMessage(raw: string): PhoenixMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 5) {
    return null;
  }
  const [joinRef, ref, topic, event, payload] = parsed;
  if (typeof topic !== "string" || typeof event !== "string") {
    return null;
  }
  return {
    joinRef: typeof joinRef === "string" ? joinRef : null,
    ref: typeof ref === "string" ? ref : null,
    topic,
    event,
    payload,
  };
}

/** SystemNotification payload (agents-protocol notification.rs contract). */
export type SystemNotification = {
  eventId: string;
  content: string;
  data: Record<string, unknown>;
};

/**
 * Parse a relay `"frame"` payload (`{seq, payload}` where `payload` is the
 * SystemNotification JSON string) into `{seq, notification}`.
 */
export function parseFramePayload(
  payload: unknown,
): { seq: number; notification: SystemNotification } | null {
  if (!isRecord(payload) || typeof payload.seq !== "number") {
    return null;
  }
  const inner = payload.payload;
  if (typeof inner !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== "SYSTEM_NOTIFICATION") {
    return null;
  }
  const eventId = readString(parsed.event_id);
  const content = typeof parsed.content === "string" ? parsed.content : "";
  if (!eventId) {
    return null;
  }
  return {
    seq: payload.seq,
    notification: {
      eventId,
      content,
      data: isRecord(parsed.data) ? parsed.data : {},
    },
  };
}

export const ORDER_PAID_EVENT = "ORDER_PAID";

/**
 * Buyer-facing text for a notification. Known events get a Chinese card-style
 * line; unknown events fall back to the raw `content` (fail-visible — never
 * silently drop a notification the backend pushed).
 */
export function formatNotificationText(notification: SystemNotification): string {
  const event = readString(notification.data.event);
  if (event === ORDER_PAID_EVENT) {
    const orderId = readString(notification.data.order_id) ?? "(未知)";
    return `✅ 订单 ${orderId} 已支付成功，卖家已确认收款，我们会尽快安排发货。`;
  }
  return notification.content || "(系统通知)";
}

// ---------------------------------------------------------------------------
// RelayPushService
// ---------------------------------------------------------------------------

export type PendingSubscription = {
  orderId: string;
  chatId: string;
  accountId?: string;
  /**
   * Telegram sender id of the buyer (= chromite channel_user_id). Used as the
   * zero-trust session token when fetching a relay join ticket
   * (chromite-relay-session-auth-v1). Optional for backward compat with rows
   * persisted before auth; a missing senderId makes fetchTicket fail → the
   * ensure-joined loop keeps retrying (fail-visible, never a silent skip).
   */
  senderId?: string;
  createdAt: number;
};

/**
 * Internal per-connection subscription record: the persisted shape plus live
 * join state.
 * - `joinRef`: last phx_join ref sent.
 * - `joined`: true only on a phx_reply ok for the topic (the relay Session must
 *   have been registered by chromite first — see the ensure-joined retry loop).
 * - `lastAckedSeq`: highest seq **acked** to relay (not merely received). Only
 *   advances at ack time (deliver success or confirmed duplicate). Sent as
 *   `resume_from_seq` on rejoin so a frame whose delivery failed (no ack, no
 *   advance) is replayed by relay, preserving no-loss resume
 *   (chromite-relay-session-auth-v1, plan §2#10).
 * - `ticketInFlight`: a fetchTicket promise is outstanding for this sub; the
 *   join loops skip it to avoid concurrent ticket fetches / double joins.
 */
type ActiveSub = PendingSubscription & {
  joinRef: string | null;
  joined: boolean;
  lastAckedSeq: number;
  ticketInFlight: boolean;
};

/**
 * Fetch a per-conv relay join ticket for a subscription. Returns the JWT string,
 * or null when the ticket cannot be obtained yet (buyer identity missing, not
 * authorized, backend down) — the caller leaves the sub for the ensure-joined
 * retry loop. Must never throw (implementations swallow + return null).
 */
export type RelayPushTicketFetcher = (sub: PendingSubscription) => Promise<string | null>;

export type RelayPushDeliver = (params: {
  chatId: string;
  accountId?: string;
  text: string;
}) => Promise<void>;

export type RelayPushSocketHandlers = {
  onOpen: () => void;
  onMessage: (raw: string) => void;
  onClose: () => void;
  onError: (err: unknown) => void;
};

export type RelayPushSocket = {
  send: (data: string) => void;
  close: () => void;
};

export type RelayPushSocketFactory = (
  url: string,
  handlers: RelayPushSocketHandlers,
) => RelayPushSocket;

export type RelayPushLogger = (
  level: "info" | "warn",
  msg: string,
  data?: Record<string, unknown>,
) => void;

type WebSocketLike = {
  send: (data: string) => void;
  close: () => void;
  addEventListener: (type: string, listener: (ev: { data?: unknown }) => void) => void;
};

const DEDUPE_RING_CAPACITY = 512;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 60_000;
// The buyer subscribes when the payment card renders, but the relay Session for
// `conv:<order_id>` is not created until the seller confirms (chromite calls
// RegisterSession then). So the first phx_join fails ("join crashed"); this
// interval re-joins any not-yet-joined subscription until the session exists,
// at which point relay replays the buffered ORDER_PAID on attach.
const DEFAULT_ENSURE_JOINED_MS = 2_000;

/** Node 22+ global WebSocket; typed structurally so no DOM lib is required. */
const defaultSocketFactory: RelayPushSocketFactory = (url, handlers) => {
  const WS = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!WS) {
    throw new Error("global WebSocket unavailable (Node 22+ required)");
  }
  const ws = new WS(url);
  ws.addEventListener("open", () => handlers.onOpen());
  ws.addEventListener("message", (ev) => {
    handlers.onMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
  });
  ws.addEventListener("close", () => handlers.onClose());
  ws.addEventListener("error", (err) => handlers.onError(err));
  return { send: (data) => ws.send(data), close: () => ws.close() };
};

export class RelayPushService {
  private readonly url: string;
  private readonly deliver: RelayPushDeliver;
  private readonly socketFactory: RelayPushSocketFactory;
  private readonly persist?: {
    save: (sub: PendingSubscription) => Promise<void>;
    remove: (orderId: string) => Promise<void>;
  };
  private readonly log: RelayPushLogger;
  private readonly heartbeatMs: number;
  private readonly reconnectBaseMs: number;
  private readonly ensureJoinedMs: number;
  private readonly now: () => number;
  /** Per-conv join ticket fetcher (chromite-relay-session-auth-v1). When unset,
   *  joins are unauthenticated (empty payload) — tests / legacy loopback only. */
  private readonly fetchTicket?: RelayPushTicketFetcher;

  private readonly subs = new Map<string, ActiveSub>();
  // Event ids whose Telegram delivery **succeeded** (committed after deliver, not
  // on receipt): a replay of the same event_id is ack'd but not re-delivered
  // (RP-I2 exactly-once delivery). Deliver failures are NOT recorded here, so a
  // rejoin replay re-delivers them (plan §2#10, four-round review fix).
  private readonly deliveredEventIds = new Set<string>();
  private readonly deliveredQueue: string[] = [];
  // Event ids with an in-flight deliver(): guards against a concurrent frame of
  // the same event (e.g. rapid replay) double-delivering before the first
  // deliver resolves.
  private readonly deliveryInFlight = new Set<string>();

  private socket: RelayPushSocket | null = null;
  private socketOpen = false;
  private stopped = false;
  private refCounter = 0;
  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private ensureJoinedTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: {
    url: string;
    deliver: RelayPushDeliver;
    socketFactory?: RelayPushSocketFactory;
    persist?: {
      save: (sub: PendingSubscription) => Promise<void>;
      remove: (orderId: string) => Promise<void>;
    };
    log?: RelayPushLogger;
    heartbeatMs?: number;
    reconnectBaseMs?: number;
    ensureJoinedMs?: number;
    now?: () => number;
    fetchTicket?: RelayPushTicketFetcher;
  }) {
    this.url = options.url;
    this.deliver = options.deliver;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.persist = options.persist;
    this.log = options.log ?? (() => {});
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.ensureJoinedMs = options.ensureJoinedMs ?? DEFAULT_ENSURE_JOINED_MS;
    this.now = options.now ?? Date.now;
    this.fetchTicket = options.fetchTicket;
  }

  /** Orders with a live pending subscription (test / diagnostics seam). */
  pendingOrders(): string[] {
    return [...this.subs.keys()];
  }

  /**
   * Register interest in ORDER_PAID pushes for `orderId`, delivered to the
   * buyer's (accountId, chatId). Idempotent per orderId. Never throws.
   */
  subscribeOrder(sub: {
    orderId: string;
    chatId: string;
    accountId?: string;
    senderId?: string;
  }): void {
    try {
      if (this.stopped || this.subs.has(sub.orderId)) {
        return;
      }
      const pending: ActiveSub = {
        orderId: sub.orderId,
        chatId: sub.chatId,
        accountId: sub.accountId,
        senderId: sub.senderId,
        createdAt: this.now(),
        joinRef: null,
        joined: false,
        lastAckedSeq: 0,
        ticketInFlight: false,
      };
      this.subs.set(sub.orderId, pending);
      void this.persist?.save(pending).catch(() => {});
      if (this.socketOpen) {
        this.join(pending);
      } else {
        this.ensureSocket();
      }
    } catch (err) {
      this.log("warn", "relay-push subscribeOrder failed", {
        orderId: sub.orderId,
        error: String(err),
      });
    }
  }

  /** Re-register persisted subscriptions after daemon restart. Never throws. */
  restoreSubscriptions(subs: PendingSubscription[]): void {
    for (const sub of subs) {
      this.subscribeOrder(sub);
    }
  }

  /** Close the socket and stop all timers (dispose / test teardown). */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    try {
      this.socket?.close();
    } catch {
      // already closed
    }
    this.socket = null;
    this.socketOpen = false;
  }

  private ensureSocket(): void {
    if (this.socket || this.stopped || this.subs.size === 0) {
      return;
    }
    const wsUrl = `${this.url.replace(/\/+$/, "")}/socket/websocket?vsn=2.0.0`;
    try {
      this.socket = this.socketFactory(wsUrl, {
        onOpen: () => this.handleOpen(),
        onMessage: (raw) => this.handleMessage(raw),
        onClose: () => this.handleClose(),
        onError: (err) => {
          this.log("warn", "relay-push socket error", { error: String(err) });
        },
      });
    } catch (err) {
      this.socket = null;
      this.log("warn", "relay-push socket connect failed", { error: String(err) });
      this.scheduleReconnect();
    }
  }

  private handleOpen(): void {
    this.socketOpen = true;
    this.reconnectAttempts = 0;
    for (const sub of this.subs.values()) {
      this.join(sub);
    }
    if (this.heartbeatTimer === null && this.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatMs);
      this.heartbeatTimer.unref?.();
    }
    if (this.ensureJoinedTimer === null && this.ensureJoinedMs > 0) {
      this.ensureJoinedTimer = setInterval(() => this.ensureJoined(), this.ensureJoinedMs);
      this.ensureJoinedTimer.unref?.();
    }
  }

  /**
   * Re-join any subscription that has not confirmed a join yet. Runs while the
   * socket is open; the buyer's session may not exist at subscribe time (it is
   * created when the seller confirms), so the first join fails and this retries
   * until it succeeds.
   */
  private ensureJoined(): void {
    if (!this.socketOpen) {
      return;
    }
    for (const sub of this.subs.values()) {
      if (!sub.joined && !sub.ticketInFlight) {
        this.join(sub);
      }
    }
  }

  private handleClose(): void {
    this.socket = null;
    this.socketOpen = false;
    for (const sub of this.subs.values()) {
      sub.joinRef = null;
      sub.joined = false;
      // A ticket fetch in flight during close is neutralized by the late-promise
      // guard in join(); clear the flag so the next open can re-fetch.
      sub.ticketInFlight = false;
    }
    this.clearTimers();
    if (!this.stopped && this.subs.size > 0) {
      this.scheduleReconnect();
    }
  }

  private handleMessage(raw: string): void {
    const msg = decodePhoenixMessage(raw);
    if (!msg) {
      this.log("warn", "relay-push undecodable message", { raw: raw.slice(0, 200) });
      return;
    }
    if (msg.event === "phx_reply") {
      // The only phx_reply on a conv topic is the join reply (ack gets no reply,
      // leave races subscription deletion). Mark joined on ok; on error (e.g.
      // "join crashed" before the relay Session exists) leave it for the
      // ensure-joined retry loop.
      const status = isRecord(msg.payload) ? msg.payload.status : undefined;
      const sub = this.subFromTopic(msg.topic);
      if (sub) {
        if (status === "ok") {
          sub.joined = true;
        } else {
          sub.joined = false;
          sub.joinRef = null;
          this.log("warn", "relay-push join reply not ok; will retry", {
            topic: msg.topic,
            payload: msg.payload,
          });
        }
      }
      return;
    }
    if (msg.event === "frame") {
      this.handleFrame(msg);
      return;
    }
    // phx_close / phx_error on a topic: drop the join ref so a reconnect
    // (or the next open) rejoins; the subscription itself stays pending.
    if (msg.event === "phx_close" || msg.event === "phx_error") {
      const sub = this.subFromTopic(msg.topic);
      if (sub) {
        sub.joinRef = null;
        this.log("warn", "relay-push channel closed by relay", { topic: msg.topic });
      }
    }
  }

  private handleFrame(msg: PhoenixMessage): void {
    const sub = this.subFromTopic(msg.topic);
    const frame = parseFramePayload(msg.payload);
    if (!sub || !frame) {
      this.log("warn", "relay-push frame ignored", { topic: msg.topic, known: Boolean(sub) });
      return;
    }
    const { seq, notification } = frame;
    const eventId = notification.eventId;

    // Already successfully delivered → ack (idempotent, trims relay buffer) and
    // advance resume point, but deliver nothing (RP-I2 exactly-once).
    if (this.deliveredEventIds.has(eventId)) {
      this.ackAndAdvance(sub, seq);
      return;
    }
    // A deliver() for this event is already running (e.g. rapid replay before
    // the first resolves): skip. The in-flight deliver acks on success; do not
    // ack here (that would advance the resume point past an unconfirmed frame).
    if (this.deliveryInFlight.has(eventId)) {
      return;
    }

    this.deliveryInFlight.add(eventId);
    const text = formatNotificationText(notification);
    void this.deliver({ chatId: sub.chatId, accountId: sub.accountId, text })
      .then(() => {
        // Commit dedupe **after** successful delivery, then ack + advance. A
        // deliver failure records nothing and does not ack, so relay replays
        // the frame on rejoin and it is re-delivered (no silent loss).
        this.rememberDelivered(eventId);
        this.ackAndAdvance(sub, seq);
        if (readString(notification.data.event) === ORDER_PAID_EVENT) {
          this.completeSubscription(sub);
        }
      })
      .catch((err) => {
        this.log("warn", "relay-push deliver failed", {
          orderId: sub.orderId,
          error: String(err),
        });
      })
      .finally(() => {
        this.deliveryInFlight.delete(eventId);
      });
  }

  /** Ack seq to relay and advance the sub's resume point (only ever forward). */
  private ackAndAdvance(sub: ActiveSub, seq: number): void {
    this.sendAck(sub, seq);
    if (seq > sub.lastAckedSeq) {
      sub.lastAckedSeq = seq;
    }
  }

  private completeSubscription(sub: ActiveSub): void {
    this.sendControl(sub.joinRef, `conv:${sub.orderId}`, "phx_leave", {});
    this.subs.delete(sub.orderId);
    void this.persist?.remove(sub.orderId).catch(() => {});
  }

  private join(sub: ActiveSub): void {
    // No ticket fetcher configured → unauthenticated join (tests / loopback):
    // preserve the historical empty-payload join exactly.
    if (!this.fetchTicket) {
      this.sendJoin(sub, {});
      return;
    }
    if (sub.ticketInFlight) {
      return;
    }
    sub.ticketInFlight = true;
    void this.fetchTicket(sub)
      .then((ticket) => {
        // Late-promise guard (chromite-relay-session-auth-v1 review round 2):
        // the socket may have closed/reopened, the service stopped, or the sub
        // been removed/joined while the ticket was in flight. Only join if this
        // exact sub object is still the live, un-joined subscription.
        if (this.stopped || !this.socketOpen || this.subs.get(sub.orderId) !== sub || sub.joined) {
          return;
        }
        if (!ticket) {
          // Buyer identity missing / not authorized yet / backend down: leave
          // for the ensure-joined retry loop (fail-visible, never a silent skip).
          this.log("warn", "relay-push no ticket; will retry", { orderId: sub.orderId });
          return;
        }
        this.sendJoin(sub, { ticket, resume_from_seq: sub.lastAckedSeq });
      })
      .catch((err) => {
        this.log("warn", "relay-push fetchTicket failed", {
          orderId: sub.orderId,
          error: String(err),
        });
      })
      .finally(() => {
        sub.ticketInFlight = false;
      });
  }

  private sendJoin(sub: ActiveSub, payload: Record<string, unknown>): void {
    const joinRef = this.nextRef();
    sub.joinRef = joinRef;
    sub.joined = false;
    this.sendControl(joinRef, `conv:${sub.orderId}`, "phx_join", payload);
  }

  private sendAck(sub: ActiveSub, seq: number): void {
    this.sendControl(sub.joinRef, `conv:${sub.orderId}`, "ack", { seq });
  }

  private sendHeartbeat(): void {
    this.sendControl(null, "phoenix", "heartbeat", {});
  }

  /**
   * RP-I1 chokepoint: every outgoing wire message goes through here, and the
   * event set is control-only. There is deliberately no code path that sends
   * an inbound business "frame".
   */
  private sendControl(
    joinRef: string | null,
    topic: string,
    event: "phx_join" | "phx_leave" | "ack" | "heartbeat",
    payload: unknown,
  ): void {
    if (!this.socket || !this.socketOpen) {
      return;
    }
    try {
      this.socket.send(
        encodePhoenixMessage({ joinRef, ref: this.nextRef(), topic, event, payload }),
      );
    } catch (err) {
      this.log("warn", "relay-push send failed", { topic, event, error: String(err) });
    }
  }

  private subFromTopic(topic: string): ActiveSub | undefined {
    if (!topic.startsWith("conv:")) {
      return undefined;
    }
    return this.subs.get(topic.slice("conv:".length));
  }

  /** Record an event_id as successfully delivered (bounded ring). */
  private rememberDelivered(eventId: string): void {
    if (this.deliveredEventIds.has(eventId)) {
      return;
    }
    this.deliveredEventIds.add(eventId);
    this.deliveredQueue.push(eventId);
    if (this.deliveredQueue.length > DEDUPE_RING_CAPACITY) {
      const evicted = this.deliveredQueue.shift();
      if (evicted) {
        this.deliveredEventIds.delete(evicted);
      }
    }
  }

  private nextRef(): string {
    this.refCounter += 1;
    return String(this.refCounter);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.stopped) {
      return;
    }
    const delay = Math.min(this.reconnectBaseMs * 2 ** this.reconnectAttempts, RECONNECT_CAP_MS);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureSocket();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ensureJoinedTimer !== null) {
      clearInterval(this.ensureJoinedTimer);
      this.ensureJoinedTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Module singleton (wired by index.ts register(); handler.ts consumes).
// ---------------------------------------------------------------------------

let serviceRef: RelayPushService | undefined;

export function initRelayPush(service: RelayPushService | undefined): void {
  serviceRef = service;
}

export function getRelayPush(): RelayPushService | undefined {
  return serviceRef;
}

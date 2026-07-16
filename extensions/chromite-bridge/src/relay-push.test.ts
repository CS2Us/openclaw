// Relay push consumer tests — spec chromite-relay-push-consumer-v1.
//
// Guarded invariants: RP-I1 (control-events-only, never an inbound "frame"),
// RP-I2 (event_id dedupe), fail-visible unknown-event fallback, and the
// side-channel guarantee (subscribeOrder never throws into the reply path).

import { describe, expect, it, vi } from "vitest";
import type { ClientAction } from "./projection-engine.js";
import {
  deletePendingSubscription,
  loadAllPendingSubscriptions,
  persistPendingSubscription,
  setRelayPushStoreForTesting,
} from "./relay-push-store.js";
import {
  decodePhoenixMessage,
  encodePhoenixMessage,
  extractOrderRef,
  formatNotificationText,
  parseFramePayload,
  RelayPushService,
  type PendingSubscription,
  type RelayPushDeliver,
  type RelayPushSocketHandlers,
} from "./relay-push.js";

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

function projectionAction(overrides: { refs?: Record<string, unknown> } = {}): ClientAction {
  return {
    kind: "interaction_projection",
    version: 1,
    projection: {
      id: "ip_x",
      domain: "commerce",
      surface: "checkout",
      entity: {
        type: "payment_intent",
        id: "pi_x",
        state: "awaiting_external_payment",
        refs: overrides.refs ?? { order_id: "ord_1", payment_id: "pay_1" },
      },
      presentation: { profile: "checkout.payment.personal_qr.v1" },
    },
  };
}

function notificationJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "SYSTEM_NOTIFICATION",
    event_id: "evt-1",
    role: "system",
    content: "Order ord_1 has been paid successfully.",
    data: { event: "ORDER_PAID", order_id: "ord_1", status: "Paid" },
    ...overrides,
  });
}

function frameRaw(topic: string, seq: number, notificationRaw: string): string {
  return JSON.stringify([null, null, topic, "frame", { seq, payload: notificationRaw }]);
}

function fakeSocket() {
  const sent: Array<{ joinRef: string | null; topic: string; event: string; payload: unknown }> =
    [];
  let handlers: RelayPushSocketHandlers | undefined;
  let factoryCalls = 0;
  const factory = (_url: string, h: RelayPushSocketHandlers) => {
    handlers = h;
    factoryCalls += 1;
    return {
      send: (data: string) => {
        const msg = decodePhoenixMessage(data);
        if (!msg) throw new Error(`fake socket got undecodable frame: ${data}`);
        sent.push({
          joinRef: msg.joinRef,
          topic: msg.topic,
          event: msg.event,
          payload: msg.payload,
        });
      },
      close: () => {},
    };
  };
  return {
    factory,
    sent,
    open: () => handlers?.onOpen(),
    message: (raw: string) => handlers?.onMessage(raw),
    close: () => handlers?.onClose(),
    get connected() {
      return handlers !== undefined;
    },
    get factoryCalls() {
      return factoryCalls;
    },
  };
}

function deliverMock() {
  return vi.fn<RelayPushDeliver>().mockResolvedValue(undefined);
}

function persistMock() {
  return {
    save: vi.fn<(sub: PendingSubscription) => Promise<void>>().mockResolvedValue(undefined),
    remove: vi.fn<(orderId: string) => Promise<void>>().mockResolvedValue(undefined),
  };
}

function makeService(opts: {
  socket: ReturnType<typeof fakeSocket>;
  deliver?: ReturnType<typeof deliverMock>;
  persist?: ReturnType<typeof persistMock>;
  ensureJoinedMs?: number;
  reconnectBaseMs?: number;
  fetchTicket?: (sub: PendingSubscription) => Promise<string | null>;
}) {
  const deliver = opts.deliver ?? deliverMock();
  const service = new RelayPushService({
    url: "ws://127.0.0.1:4000",
    deliver,
    socketFactory: opts.socket.factory,
    persist: opts.persist,
    heartbeatMs: 0,
    // Disabled by default so tests that don't simulate a join reply stay
    // deterministic; the retry test opts in with a small interval.
    ensureJoinedMs: opts.ensureJoinedMs ?? 0,
    reconnectBaseMs: opts.reconnectBaseMs ?? 3_600_000,
    fetchTicket: opts.fetchTicket,
  });
  return { service, deliver };
}

function joinReply(topic: string, status: "ok" | "error"): string {
  const response = status === "ok" ? {} : { reason: "join crashed" };
  return JSON.stringify([null, "r", topic, "phx_reply", { status, response }]);
}

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

describe("extractOrderRef", () => {
  it("extracts order_id + payment_id from interaction_projection entity refs", () => {
    expect(extractOrderRef([projectionAction()])).toEqual({
      orderId: "ord_1",
      paymentId: "pay_1",
    });
  });

  it("returns null payment_id when absent but keeps order_id", () => {
    expect(extractOrderRef([projectionAction({ refs: { order_id: "ord_2" } })])).toEqual({
      orderId: "ord_2",
      paymentId: null,
    });
  });

  it("returns null without order_id, without projection, or for other kinds", () => {
    expect(extractOrderRef(undefined)).toBeNull();
    expect(extractOrderRef([])).toBeNull();
    expect(extractOrderRef([projectionAction({ refs: {} })])).toBeNull();
    expect(extractOrderRef([{ kind: "payment_request", version: 1, projection: {} }])).toBeNull();
    expect(
      extractOrderRef([{ kind: "interaction_projection", version: 2, projection: {} }]),
    ).toBeNull();
  });
});

describe("phoenix wire codec", () => {
  it("round-trips a V2 message", () => {
    const encoded = encodePhoenixMessage({
      joinRef: "1",
      ref: "2",
      topic: "conv:ord_1",
      event: "phx_join",
      payload: {},
    });
    expect(JSON.parse(encoded)).toEqual(["1", "2", "conv:ord_1", "phx_join", {}]);
    expect(decodePhoenixMessage(encoded)).toEqual({
      joinRef: "1",
      ref: "2",
      topic: "conv:ord_1",
      event: "phx_join",
      payload: {},
    });
  });

  it("rejects non-array, wrong-arity, and non-JSON input", () => {
    expect(decodePhoenixMessage("not json")).toBeNull();
    expect(decodePhoenixMessage('{"topic":"x"}')).toBeNull();
    expect(decodePhoenixMessage('["1","2","topic"]')).toBeNull();
  });
});

describe("parseFramePayload + formatNotificationText", () => {
  it("parses a SystemNotification frame payload", () => {
    const parsed = parseFramePayload({ seq: 7, payload: notificationJson() });
    expect(parsed).toEqual({
      seq: 7,
      notification: {
        eventId: "evt-1",
        content: "Order ord_1 has been paid successfully.",
        data: { event: "ORDER_PAID", order_id: "ord_1", status: "Paid" },
      },
    });
  });

  it("rejects payloads without seq, string body, type, or event_id", () => {
    expect(parseFramePayload({ payload: notificationJson() })).toBeNull();
    expect(parseFramePayload({ seq: 1, payload: 42 })).toBeNull();
    expect(parseFramePayload({ seq: 1, payload: "not json" })).toBeNull();
    expect(parseFramePayload({ seq: 1, payload: JSON.stringify({ type: "OTHER" }) })).toBeNull();
    expect(
      parseFramePayload({ seq: 1, payload: notificationJson({ event_id: undefined }) }),
    ).toBeNull();
  });

  it("renders ORDER_PAID as buyer-facing Chinese text with the order id", () => {
    const parsed = parseFramePayload({ seq: 1, payload: notificationJson() });
    expect(formatNotificationText(parsed!.notification)).toContain("ord_1");
    expect(formatNotificationText(parsed!.notification)).toContain("已支付成功");
  });

  it("falls back to raw content for unknown events (fail-visible)", () => {
    const parsed = parseFramePayload({
      seq: 1,
      payload: notificationJson({
        content: "Async task t-9 is complete.",
        data: { event: "TICKET_RESOLVED", ticket_id: "t-9" },
      }),
    });
    expect(formatNotificationText(parsed!.notification)).toBe("Async task t-9 is complete.");
  });
});

// --------------------------------------------------------------------------
// RelayPushService roundtrip
// --------------------------------------------------------------------------

describe("RelayPushService", () => {
  it("subscribe → join → ORDER_PAID frame → deliver → ack → leave → pending cleared", async () => {
    const socket = fakeSocket();
    const persist = persistMock();
    const { service, deliver } = makeService({ socket, persist });

    service.subscribeOrder({ orderId: "ord_1", chatId: "555", accountId: "acc" });
    expect(socket.connected).toBe(true);
    expect(persist.save).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "ord_1", chatId: "555", accountId: "acc" }),
    );

    socket.open();
    const join = socket.sent.find((m) => m.event === "phx_join");
    expect(join).toMatchObject({ topic: "conv:ord_1" });

    socket.message(frameRaw("conv:ord_1", 1, notificationJson()));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(deliver).toHaveBeenCalledWith({
      chatId: "555",
      accountId: "acc",
      text: expect.stringContaining("ord_1"),
    });

    await vi.waitFor(() => {
      expect(socket.sent.find((m) => m.event === "ack")).toMatchObject({
        topic: "conv:ord_1",
        payload: { seq: 1 },
      });
      expect(socket.sent.find((m) => m.event === "phx_leave")).toMatchObject({
        topic: "conv:ord_1",
      });
    });
    expect(service.pendingOrders()).toEqual([]);
    expect(persist.remove).toHaveBeenCalledWith("ord_1");
    service.stop();
  });

  it("RP-I2: duplicate event_id delivers once but acks both frames", async () => {
    const socket = fakeSocket();
    const { service, deliver } = makeService({ socket });
    service.subscribeOrder({ orderId: "ord_1", chatId: "555" });
    socket.open();

    const unknownEvent = notificationJson({
      data: { event: "TICKET_RESOLVED", ticket_id: "t-1" },
    });
    socket.message(frameRaw("conv:ord_1", 1, unknownEvent));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    socket.message(frameRaw("conv:ord_1", 2, unknownEvent));
    await vi.waitFor(() => expect(socket.sent.filter((m) => m.event === "ack")).toHaveLength(2));
    expect(deliver).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it("unknown event keeps the subscription pending (no leave)", async () => {
    const socket = fakeSocket();
    const { service, deliver } = makeService({ socket });
    service.subscribeOrder({ orderId: "ord_1", chatId: "555" });
    socket.open();
    socket.message(
      frameRaw(
        "conv:ord_1",
        1,
        notificationJson({ content: "hello", data: { event: "SOMETHING_NEW" } }),
      ),
    );
    await vi.waitFor(() =>
      expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ text: "hello" })),
    );
    expect(socket.sent.find((m) => m.event === "phx_leave")).toBeUndefined();
    expect(service.pendingOrders()).toEqual(["ord_1"]);
    service.stop();
  });

  it("RP-I1: never sends an inbound business frame — control events only", async () => {
    const socket = fakeSocket();
    const { service, deliver } = makeService({ socket });
    service.subscribeOrder({ orderId: "ord_1", chatId: "555" });
    socket.open();
    socket.message(frameRaw("conv:ord_1", 1, notificationJson()));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalled());
    await vi.waitFor(() => expect(socket.sent.find((m) => m.event === "phx_leave")).toBeDefined());
    const events = new Set(socket.sent.map((m) => m.event));
    expect(events.has("frame")).toBe(false);
    for (const event of events) {
      expect(["phx_join", "phx_leave", "ack", "heartbeat"]).toContain(event);
    }
    service.stop();
  });

  it("delivery failure: no ack, subscription stays pending (relay redelivers after restart)", async () => {
    const socket = fakeSocket();
    const deliver = vi.fn<RelayPushDeliver>().mockRejectedValue(new Error("telegram down"));
    const { service } = makeService({ socket, deliver });
    service.subscribeOrder({ orderId: "ord_1", chatId: "555" });
    socket.open();
    socket.message(frameRaw("conv:ord_1", 1, notificationJson()));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(socket.sent.find((m) => m.event === "ack")).toBeUndefined();
    expect(service.pendingOrders()).toEqual(["ord_1"]);
    service.stop();
  });

  it("subscribeOrder is idempotent per order and never throws (side-channel guarantee)", () => {
    const explodingFactory = () => {
      throw new Error("no websocket here");
    };
    const service = new RelayPushService({
      url: "ws://127.0.0.1:4000",
      deliver: deliverMock(),
      socketFactory: explodingFactory,
      heartbeatMs: 0,
      reconnectBaseMs: 3_600_000,
    });
    expect(() => service.subscribeOrder({ orderId: "ord_1", chatId: "555" })).not.toThrow();
    expect(() => service.subscribeOrder({ orderId: "ord_1", chatId: "555" })).not.toThrow();
    expect(service.pendingOrders()).toEqual(["ord_1"]);
    service.stop();
  });

  it("rejoins all pending topics after reconnect", async () => {
    const socket = fakeSocket();
    const { service } = makeService({ socket });
    service.subscribeOrder({ orderId: "ord_1", chatId: "555" });
    service.subscribeOrder({ orderId: "ord_2", chatId: "556" });
    socket.open();
    expect(socket.sent.filter((m) => m.event === "phx_join")).toHaveLength(2);
    socket.open(); // simulate transport-level rejoin trigger
    const joins = socket.sent.filter((m) => m.event === "phx_join");
    expect(joins.map((j) => j.topic).sort()).toEqual([
      "conv:ord_1",
      "conv:ord_1",
      "conv:ord_2",
      "conv:ord_2",
    ]);
    service.stop();
  });

  it("retries join until the relay session exists, then consumes the replayed frame", async () => {
    const socket = fakeSocket();
    const { service, deliver } = makeService({ socket, ensureJoinedMs: 5 });
    service.subscribeOrder({ orderId: "ord_1", chatId: "555" });
    socket.open();
    // First join fails: the buyer subscribed before the seller confirmed, so
    // the relay Session for conv:ord_1 does not exist yet ("join crashed").
    expect(socket.sent.filter((m) => m.event === "phx_join")).toHaveLength(1);
    socket.message(joinReply("conv:ord_1", "error"));
    // ensure-joined tick re-joins.
    await vi.waitFor(() =>
      expect(socket.sent.filter((m) => m.event === "phx_join").length).toBeGreaterThanOrEqual(2),
    );
    // Now chromite has registered the session → join ok, relay replays the
    // buffered ORDER_PAID frame on attach.
    socket.message(joinReply("conv:ord_1", "ok"));
    socket.message(frameRaw("conv:ord_1", 1, notificationJson()));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    service.stop();
  });

  it("stops re-joining once a join reply confirms the subscription", async () => {
    const socket = fakeSocket();
    const { service } = makeService({ socket, ensureJoinedMs: 5 });
    service.subscribeOrder({ orderId: "ord_1", chatId: "555" });
    socket.open();
    socket.message(joinReply("conv:ord_1", "ok"));
    // Give the ensure-joined tick several intervals; a confirmed sub must not
    // be re-joined.
    await new Promise((r) => setTimeout(r, 30));
    expect(socket.sent.filter((m) => m.event === "phx_join")).toHaveLength(1);
    service.stop();
  });
});

// --------------------------------------------------------------------------
// Pending-subscription store (fake keyed store, chat-state-store pattern)
// --------------------------------------------------------------------------

describe("relay-push-store", () => {
  it("persists, hydrates, and deletes pending subscriptions", async () => {
    const backing = new Map<string, PendingSubscription>();
    setRelayPushStoreForTesting({
      entries: async () => [...backing.entries()].map(([key, value]) => ({ key, value })),
      set: async (key, value) => {
        backing.set(key, value);
      },
      delete: async (key) => {
        backing.delete(key);
      },
    });
    try {
      const sub: PendingSubscription = {
        orderId: "ord_1",
        chatId: "555",
        accountId: "acc",
        createdAt: 123,
      };
      await persistPendingSubscription(sub);
      expect(await loadAllPendingSubscriptions()).toEqual([sub]);
      await deletePendingSubscription("ord_1");
      expect(await loadAllPendingSubscriptions()).toEqual([]);
    } finally {
      setRelayPushStoreForTesting(undefined);
    }
  });

  it("degrades to empty when the store is unavailable", async () => {
    setRelayPushStoreForTesting(null);
    try {
      await persistPendingSubscription({
        orderId: "ord_1",
        chatId: "555",
        createdAt: 1,
      });
      expect(await loadAllPendingSubscriptions()).toEqual([]);
    } finally {
      setRelayPushStoreForTesting(undefined);
    }
  });
});

// --------------------------------------------------------------------------
// chromite-relay-session-auth-v1: ticketed join + resume + dedupe timing
// --------------------------------------------------------------------------

describe("RelayPushService — ticketed join (auth)", () => {
  it("join carries the fetched ticket and resume_from_seq in the payload", async () => {
    const socket = fakeSocket();
    const fetchTicket = vi.fn().mockResolvedValue("jwt-abc");
    const { service } = makeService({ socket, fetchTicket });
    service.subscribeOrder({ orderId: "ord_1", chatId: "555", senderId: "buyer-9" });
    socket.open();
    await vi.waitFor(() => expect(socket.sent.find((m) => m.event === "phx_join")).toBeDefined());
    const join = socket.sent.find((m) => m.event === "phx_join");
    expect(fetchTicket).toHaveBeenCalledWith(expect.objectContaining({ senderId: "buyer-9" }));
    expect(join?.payload).toEqual({ ticket: "jwt-abc", resume_from_seq: 0 });
    service.stop();
  });

  it("null ticket → no join sent, retried by ensure-joined loop", async () => {
    const socket = fakeSocket();
    let ticket: string | null = null;
    const fetchTicket = vi.fn().mockImplementation(() => Promise.resolve(ticket));
    const { service } = makeService({ socket, fetchTicket, ensureJoinedMs: 5 });
    service.subscribeOrder({ orderId: "ord_1", chatId: "555", senderId: "buyer-9" });
    socket.open();
    // First attempt: no ticket → no join.
    await vi.waitFor(() => expect(fetchTicket).toHaveBeenCalled());
    expect(socket.sent.find((m) => m.event === "phx_join")).toBeUndefined();
    // Ticket becomes available → ensure-joined retry sends the join.
    ticket = "jwt-late";
    await vi.waitFor(() =>
      expect(socket.sent.find((m) => m.event === "phx_join")?.payload).toEqual({
        ticket: "jwt-late",
        resume_from_seq: 0,
      }),
    );
    service.stop();
  });

  it("rejoin resume_from_seq reflects last ACKed seq, not last received", async () => {
    const socket = fakeSocket();
    const fetchTicket = vi.fn().mockResolvedValue("jwt-x");
    const { service, deliver } = makeService({
      socket,
      fetchTicket,
      reconnectBaseMs: 5,
    });
    service.subscribeOrder({ orderId: "ord_1", chatId: "555", senderId: "buyer-9" });
    socket.open();
    await vi.waitFor(() => expect(socket.sent.find((m) => m.event === "phx_join")).toBeDefined());
    socket.message(joinReply("conv:ord_1", "ok"));

    // Deliver seq 1,2 successfully (unknown event so subscription stays open).
    const evt = (id: string) =>
      notificationJson({ event_id: id, content: "x", data: { event: "SOMETHING" } });
    socket.message(frameRaw("conv:ord_1", 1, evt("e1")));
    socket.message(frameRaw("conv:ord_1", 2, evt("e2")));
    await vi.waitFor(() => expect(socket.sent.filter((m) => m.event === "ack")).toHaveLength(2));
    expect(deliver).toHaveBeenCalledTimes(2);

    // Reconnect: close resets join state (joined=false) + schedules reconnect →
    // ensureSocket recreates the transport; then onOpen rejoins. Must resume
    // from 2 (highest acked), not last received.
    socket.close();
    // Wait for the reconnect timer to recreate the transport (factory called
    // again), then fire onOpen on the fresh socket.
    await vi.waitFor(() => expect(socket.factoryCalls).toBeGreaterThanOrEqual(2));
    socket.open();
    await vi.waitFor(() =>
      expect(socket.sent.filter((m) => m.event === "phx_join").at(-1)?.payload).toEqual({
        ticket: "jwt-x",
        resume_from_seq: 2,
      }),
    );
    service.stop();
  });

  it("deliver failure does not commit dedupe: replay re-delivers (no silent loss)", async () => {
    const socket = fakeSocket();
    const fetchTicket = vi.fn().mockResolvedValue("jwt-x");
    // First deliver rejects, second (replay) resolves.
    const deliver = vi
      .fn<RelayPushDeliver>()
      .mockRejectedValueOnce(new Error("telegram down"))
      .mockResolvedValue(undefined);
    const { service } = makeService({ socket, fetchTicket, deliver });
    service.subscribeOrder({ orderId: "ord_1", chatId: "555", senderId: "buyer-9" });
    socket.open();
    await vi.waitFor(() => expect(socket.sent.find((m) => m.event === "phx_join")).toBeDefined());

    const evt = notificationJson({ event_id: "e-dup", content: "x", data: { event: "SOMETHING" } });
    // seq 4 delivery fails → no ack, no dedupe commit. Wait for the rejection to
    // fully settle (deliveryInFlight cleared in .finally) — in production the
    // replay only arrives on a later rejoin, well after this settles.
    socket.message(frameRaw("conv:ord_1", 4, evt));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(socket.sent.find((m) => m.event === "ack")).toBeUndefined());
    await new Promise((r) => setTimeout(r, 0));

    // relay replays same event_id at seq 4 → must re-deliver (NOT duplicate-skip).
    socket.message(frameRaw("conv:ord_1", 4, evt));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(socket.sent.find((m) => m.event === "ack")).toMatchObject({ payload: { seq: 4 } }),
    );
    service.stop();
  });

  it("restoreSubscriptions carries senderId through to fetchTicket", async () => {
    const socket = fakeSocket();
    const fetchTicket = vi.fn().mockResolvedValue("jwt-r");
    const { service } = makeService({ socket, fetchTicket });
    service.restoreSubscriptions([
      { orderId: "ord_1", chatId: "555", senderId: "buyer-7", createdAt: 1 },
    ]);
    socket.open();
    await vi.waitFor(() => expect(fetchTicket).toHaveBeenCalled());
    expect(fetchTicket).toHaveBeenCalledWith(expect.objectContaining({ senderId: "buyer-7" }));
    service.stop();
  });

  it("concurrent join attempts do not double-fetch a ticket (ticketInFlight)", async () => {
    const socket = fakeSocket();
    let resolveTicket: (t: string | null) => void = () => {};
    const fetchTicket = vi
      .fn()
      .mockImplementation(() => new Promise<string | null>((r) => (resolveTicket = r)));
    const { service } = makeService({ socket, fetchTicket, ensureJoinedMs: 2 });
    service.subscribeOrder({ orderId: "ord_1", chatId: "555", senderId: "buyer-9" });
    socket.open();
    // While the first fetch is in flight, ensure-joined ticks must not fetch again.
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchTicket).toHaveBeenCalledTimes(1);
    resolveTicket("jwt-final");
    await vi.waitFor(() => expect(socket.sent.find((m) => m.event === "phx_join")).toBeDefined());
    service.stop();
  });
});

// Shared dispatch entry for chromite-bridge —— used by both /chromite command
// and Telegram DM fallthrough.
//
// hybrid-harness Part B（2026-05-30）：server-side loop (`/v1/chat/stream`) 已全删，
// Agent Loop 下放给本 edge client。每轮：resolveIdentity（绑 channel↔user）→
// runEdgeLoop（gateway turn ↔ commerce RPC 循环）→ 截断回复。
//
// 原 sub-spec chromite-harness-openclaw-bridge-v1 §1 + §4。

import { chatStateKey, getOrCreateChatState, markUsed } from "./chat-state.js";
import { resolveIdentity, runEdgeLoop } from "./chromite-client.js";
import {
  resolveChromiteUrl,
  resolveInteractionRuntimeMode,
  resolveMaxReplyChars,
  resolvePendingStoreDir,
  resolveRequestTimeoutMs,
  type ChromiteBridgeConfig,
} from "./config.js";
import { truncate } from "./format.js";
import { buildInteractionButtons, type ProjectionButtonsBlock } from "./projection-engine.js";

const TELEGRAM_CHANNEL = "telegram";

export type BridgeHandlerInput = {
  /** chat / conversation id from the channel adapter (telegram chat_id). */
  chatId: string;
  /** bot account id (multi-bot isolation). */
  accountId?: string;
  /** User-typed text body (after command prefix strip if applicable). */
  text: string;
  /**
   * Sender's channel-scoped user id, used for chromite identity resolution
   * (spec resolution-middleware-v1 §2 #D/#E). Commands set this from
   * `ctx.senderId`; telegram DM fallthrough uses `event.chatId` as proxy.
   * Optional —— chromite skips resolution when missing.
   */
  senderId?: string;
  pluginConfig?: unknown;
  /** Test seam —— inject deterministic fetch / abort signal. */
  fetchImpl?: typeof fetch;
};

export type BridgeHandlerResult = {
  reply: string;
  /** Optional client-side interactive controls, e.g. buyer payment buttons. */
  interactive?: {
    blocks: ProjectionButtonsBlock[];
  };
  /** chromite session_id used (caller can log for tracing). */
  sessionId: string;
};

/**
 * Run one bridge round: resolve session_id from chat-state, resolve chromite
 * identity (bind channel↔user), drive the client-side agent loop, return final
 * reply text.
 *
 * hybrid-harness Part B（2026-05-30）：Agent Loop 在本 edge client。Telegram bot 端
 * 的 message 由 caller (fallthrough / command) 走 PluginInboundFallthroughResult.reply
 * 或 PluginCommandResult.reply 单条 send。network error → graceful reply。
 */
export async function dispatchChromiteRound(
  input: BridgeHandlerInput,
): Promise<BridgeHandlerResult> {
  const config = (input.pluginConfig ?? {}) as ChromiteBridgeConfig;
  const chromiteUrl = resolveChromiteUrl(config);
  const maxReplyChars = resolveMaxReplyChars(config);
  const timeoutMs = resolveRequestTimeoutMs(config);
  const interactionRuntimeMode = resolveInteractionRuntimeMode(config);
  // OPT-IN durable resilience (chromite sub-spec ④ R1): undefined unless an
  // operator sets CHROMITE_PENDING_STORE_DIR / plugin config. When set, the
  // native loop restores an interrupted session on the next round with the same
  // sessionId. ⚠️ Gated on backend commerce idempotency — see resolvePendingStoreDir.
  const pendingStoreDir = resolvePendingStoreDir(config);

  const text = input.text.trim();
  if (!text) {
    return {
      reply: "(空消息，已忽略)",
      sessionId: "",
    };
  }

  const key = chatStateKey(input.accountId, input.chatId);
  const state = getOrCreateChatState(key);
  const sessionId = state.sessionId;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const edgeOpts = {
    chromiteUrl,
    channel: TELEGRAM_CHANNEL,
    channelUserId: input.senderId ?? "",
    signal: controller.signal,
    fetchImpl: input.fetchImpl,
    pendingStoreDir,
  };

  let reply: string;
  let interactionButtons: ProjectionButtonsBlock | null = null;
  try {
    // 1. Bind (channel, senderId) so the zero-trust commerce RPCs resolve.
    //    Guard for dev / CLI parity: fallthrough/command may lack senderId.
    if (input.senderId) {
      await resolveIdentity(edgeOpts);
    }
    // 2. Drive the client-side agent loop.
    const result = await runEdgeLoop(text, sessionId, edgeOpts);
    reply = result.reply;
    // Bind the pending-operation tokens to this round's principal (bot account +
    // channel sender), so only the same user can redeem them via /chromite-pay.
    interactionButtons = buildInteractionButtons(
      result.clientActions,
      {
        accountId: input.accountId,
        senderId: input.senderId ?? "",
      },
      {
        runtimeMode: interactionRuntimeMode,
      },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const aborted = controller.signal.aborted;
    const message = aborted ? `chromite request timed out after ${timeoutMs} ms` : detail;
    reply = `⚠️ 出错：${message}`;
  } finally {
    clearTimeout(timer);
  }

  // Mark chat-state usage on any round (even if errored, we still touch
  // lastUsedAt so the state isn't stale-evicted prematurely).
  markUsed(key);

  return {
    reply: truncate(reply, maxReplyChars),
    ...(interactionButtons ? { interactive: { blocks: [interactionButtons] } } : {}),
    sessionId,
  };
}

/**
 * Strip leading `/chromite` (optional, with optional whitespace) from the
 * raw command text so the body can be reused as `user_msg`.
 */
export function stripChromitePrefix(text: string): string {
  return text.replace(/^\/chromite(\s+|$)/, "").trim();
}

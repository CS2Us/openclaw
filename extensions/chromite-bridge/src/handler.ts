// Shared dispatch entry for chromite-bridge —— used by both /chromite command
// and Telegram DM fallthrough. v1 collect-then-reply form.
//
// sub-spec chromite-harness-openclaw-bridge-v1 §1 + §4 实施步骤 7.

import { chatStateKey, getOrCreateChatState, markUsed } from "./chat-state.js";
import { streamChromiteChat, type ChromiteEvent } from "./chromite-client.js";
import {
  resolveChromiteUrl,
  resolveMaxReplyChars,
  resolveRequestTimeoutMs,
  type ChromiteBridgeConfig,
} from "./config.js";
import { applyEvent, finalizeReply, newAccumulator, truncate } from "./format.js";

export type BridgeHandlerInput = {
  /** chat / conversation id from the channel adapter (telegram chat_id). */
  chatId: string;
  /** bot account id (multi-bot isolation). */
  accountId?: string;
  /** User-typed text body (after command prefix strip if applicable). */
  text: string;
  pluginConfig?: unknown;
  /** Test seam —— inject deterministic fetch / abort signal. */
  fetchImpl?: typeof fetch;
};

export type BridgeHandlerResult = {
  reply: string;
  /** chromite session_id used (caller can log for tracing). */
  sessionId: string;
};

/**
 * Run one bridge round: resolve session_id from chat-state, POST to chromite
 * chat endpoint, accumulate SSE events, return final reply text.
 *
 * v1 = collect-then-reply（§3 决策 #B 修正）. Telegram bot 端的 message
 * 由 caller (fallthrough / command) 走 PluginInboundFallthroughResult.reply
 * 或 PluginCommandResult.reply 单条 send。real-time streaming 留 v1.5.
 */
export async function dispatchChromiteRound(
  input: BridgeHandlerInput,
): Promise<BridgeHandlerResult> {
  const config = (input.pluginConfig ?? {}) as ChromiteBridgeConfig;
  const chromiteUrl = resolveChromiteUrl(config);
  const maxReplyChars = resolveMaxReplyChars(config);
  const timeoutMs = resolveRequestTimeoutMs(config);

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

  const acc = newAccumulator();
  try {
    const gen = streamChromiteChat(
      { session_id: sessionId, user_msg: text },
      {
        chromiteUrl,
        signal: controller.signal,
        fetchImpl: input.fetchImpl,
      },
    );
    for await (const ev of gen) {
      applyEvent(acc, ev);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const aborted = controller.signal.aborted;
    acc.errorMessage =
      aborted && !acc.errorMessage ? `chromite request timed out after ${timeoutMs} ms` : detail;
  } finally {
    clearTimeout(timer);
  }

  // Mark chat-state usage on any successful turn (even if errored mid-stream,
  // we still touch lastUsedAt so the state isn't stale-evicted prematurely).
  markUsed(key);

  const reply = finalizeReply(acc, maxReplyChars);
  return {
    reply: truncate(reply, maxReplyChars),
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

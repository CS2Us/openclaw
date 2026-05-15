// In-memory per-chat session_id table for chromite-bridge.
// sub-spec chromite-harness-openclaw-bridge-v1 §2 + §3 决策 #C + #D.
//
// Key shape: `${accountId ?? "default"}:${chatId}` (decision #D：bot account
// 维度 + telegram chat 维度联合). Value: PersistedChatState containing chromite
// session UUID.
//
// In-memory Map 是 hot path 同步真理；chat-state-store.ts 是写穿透 mirror
// (failures degrade gracefully — bridge continues with in-memory only).

import {
  deleteChatState,
  loadAllChatStates,
  persistChatState,
  type PersistedChatState,
} from "./chat-state-store.js";

export type ChatStateKey = string;

const STATES = new Map<ChatStateKey, PersistedChatState>();

export function chatStateKey(accountId: string | undefined, chatId: string): ChatStateKey {
  const acc = accountId && accountId.trim() ? accountId.trim() : "default";
  return `${acc}:${chatId}`;
}

export async function hydrateChatStatesFromStore(): Promise<void> {
  const persisted = await loadAllChatStates();
  for (const [key, value] of persisted) {
    STATES.set(key, value);
  }
}

export function getChatState(key: ChatStateKey): PersistedChatState | undefined {
  return STATES.get(key);
}

/**
 * Read-or-create. First call for a (accountId, chatId) pair generates a new
 * chromite session UUID via {@link generateSessionId}; subsequent calls return
 * the persisted record so chromite can resume the same session_id.
 */
export function getOrCreateChatState(
  key: ChatStateKey,
  now: number = Date.now(),
  generateSessionId: () => string = defaultGenerateSessionId,
): PersistedChatState {
  const existing = STATES.get(key);
  if (existing) {
    return existing;
  }
  const fresh: PersistedChatState = {
    sessionId: generateSessionId(),
    createdAt: now,
    lastUsedAt: now,
  };
  STATES.set(key, fresh);
  // fire-and-forget persistence
  void persistChatState(key, fresh).catch(() => {
    // chat-state-store already disables itself on errors
  });
  return fresh;
}

export function markUsed(key: ChatStateKey, now: number = Date.now()): void {
  const cur = STATES.get(key);
  if (!cur) return;
  const next: PersistedChatState = { ...cur, lastUsedAt: now };
  STATES.set(key, next);
  void persistChatState(key, next).catch(() => {});
}

export async function resetChatState(key: ChatStateKey): Promise<void> {
  STATES.delete(key);
  await deleteChatState(key);
}

/** Test-only —— clear in-memory state. */
export function _resetInMemoryForTest(): void {
  STATES.clear();
}

function defaultGenerateSessionId(): string {
  // Node 19+ exposes globalThis.crypto.randomUUID
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // Fallback (very rare on Node 22+)
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

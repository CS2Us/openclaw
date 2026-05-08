// Per-chat session state for claude-bridge. Keeps the most recent claude
// session_id per Telegram chat so plain DMs continue with `claude -p --resume`.
// In-process Map is the synchronous source of truth; chat-state-store.ts
// mirrors every mutation to a SQLite-backed plugin keyed-store so the bridge
// auto-resumes prior sessions across openclaw daemon restart.
//
// Key shape: `${channel}:${chatId}`, e.g. "telegram:12345". This matches the
// shape of `PluginCommandContext.to` for DM-style channels and lets the
// fallthrough handler and the /claude command share one keyspace.

import { deleteChatStateInStore, loadAllChatStates, persistChatState } from "./chat-state-store.js";

export type ChatStateKey = string;

export type ChatState = {
  sessionId: string | null;
  lastUsedAt: number;
};

const STATES = new Map<ChatStateKey, ChatState>();

export function chatStateKey(channel: string, chatId: string): ChatStateKey {
  return `${channel}:${chatId}`;
}

export function getOrCreateChatState(key: ChatStateKey): ChatState {
  let state = STATES.get(key);
  if (!state) {
    state = { sessionId: null, lastUsedAt: Date.now() };
    STATES.set(key, state);
  }
  return state;
}

export function resetChatState(key: ChatStateKey): void {
  STATES.set(key, { sessionId: null, lastUsedAt: Date.now() });
  // User-initiated wipe: drop the persisted row entirely so a daemon restart
  // doesn't auto-resume the killed session.
  deleteChatStateInStore(key);
}

export function updateChatStateAfterTurn(key: ChatStateKey, sessionId: string | null): void {
  const state = getOrCreateChatState(key);
  if (sessionId) {
    state.sessionId = sessionId;
  }
  state.lastUsedAt = Date.now();
  persistChatState(key, { sessionId: state.sessionId, lastUsedAt: state.lastUsedAt });
}

/**
 * Pin chat state to an externally-discovered session id (e.g. `/claude continue`
 * adopting the cwd's most-recent local-CLI session). Differs from
 * updateChatStateAfterTurn by being a deliberate user-initiated swap rather
 * than a turn-end side effect.
 */
export function adoptChatStateSession(key: ChatStateKey, sessionId: string): void {
  const state = getOrCreateChatState(key);
  state.sessionId = sessionId;
  state.lastUsedAt = Date.now();
  persistChatState(key, { sessionId: state.sessionId, lastUsedAt: state.lastUsedAt });
}

/**
 * Hydrate the in-memory map from the persistent store. Called once at plugin
 * register so the very first DM after a daemon restart picks up the prior
 * sessionId (and thus spawns claude with `--resume`). Existing in-memory
 * entries win to avoid clobbering live state across hot reload.
 */
export async function hydrateChatStatesFromStore(): Promise<number> {
  const persisted = await loadAllChatStates();
  let restored = 0;
  for (const [key, record] of persisted) {
    if (STATES.has(key)) {
      continue;
    }
    STATES.set(key, {
      sessionId: record.sessionId,
      lastUsedAt: record.lastUsedAt,
    });
    restored++;
  }
  return restored;
}

export function clearAllChatStatesForTesting(): void {
  STATES.clear();
}

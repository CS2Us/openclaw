// Per-chat session state for claude-bridge. Keeps the most recent claude
// session_id per Telegram chat so plain DMs continue with `claude -p --resume`.
// v1: in-process Map; v2 will project onto a Gateway session row via
// `registerSessionExtension` (see spec §5).
//
// Key shape: `${channel}:${chatId}`, e.g. "telegram:12345". This matches the
// shape of `PluginCommandContext.to` for DM-style channels and lets the
// fallthrough handler and the /claude command share one keyspace.

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
}

export function updateChatStateAfterTurn(key: ChatStateKey, sessionId: string | null): void {
  const state = getOrCreateChatState(key);
  if (sessionId) {
    state.sessionId = sessionId;
  }
  state.lastUsedAt = Date.now();
}

export function clearAllChatStatesForTesting(): void {
  STATES.clear();
}

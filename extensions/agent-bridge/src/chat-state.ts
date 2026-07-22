// Per-chat session state for agent-bridge. Each Telegram chat owns multiple
// concurrent agent sessions modeled as "tabs" (browser-tab semantics): one
// active at any moment, plain DM goes to the active tab, user switches via
// inline-keyboard UI rendered by /agent.
//
// In-process Map is the synchronous source of truth; chat-state-store.ts
// mirrors every mutation to a SQLite-backed plugin keyed-store so the bridge
// auto-resumes prior sessions across daemon restart.
//
// Key shape: `${channel}:${chatId}`, e.g. "telegram:12345". This matches the
// shape of `PluginCommandContext.to` for DM-style channels and lets the
// fallthrough handler and the /agent command share one keyspace.
//
// Persistence shape evolution:
//   v1 (P5): { sessionId: string|null, lastUsedAt: number }       — single session
//   v2 (P6): { tabs: Tab[], activeTabId: TabId|null, lastUsedAt } — multi-tab
// Old v1 records auto-migrate on first read.

import {
  deleteChatStateInStore,
  loadAllChatStates,
  persistChatState,
  type PersistedChatStateRecord,
} from "./chat-state-store.js";
import { chatIdFromChatKey, clearFollowMarker, writeFollowMarker } from "./follow-marker.js";

export type ChatStateKey = string;
export type TabId = string;

export type Tab = {
  id: TabId;
  sessionId: string | null;
  /** Absent means a legacy Claude session or a fresh tab not yet bound. */
  provider?: "claude" | "codex" | "gemini";
  /**
   * Display label. Auto-derived from first user message when empty / still the
   * default "Tab N"; user can later rename via UI (post-MVP).
   */
  label: string;
  createdAt: number;
  lastUsedAt: number;
};

export type ChatState = {
  tabs: Tab[];
  activeTabId: TabId | null;
  lastUsedAt: number;
};

const STATES = new Map<ChatStateKey, ChatState>();

export function chatStateKey(channel: string, chatId: string): ChatStateKey {
  return `${channel}:${chatId}`;
}

export function getOrCreateChatState(key: ChatStateKey): ChatState {
  let state = STATES.get(key);
  if (!state) {
    state = { tabs: [], activeTabId: null, lastUsedAt: Date.now() };
    STATES.set(key, state);
  }
  return state;
}

export function getActiveTab(state: ChatState): Tab | null {
  if (!state.activeTabId) {
    return null;
  }
  return state.tabs.find((t) => t.id === state.activeTabId) ?? null;
}

/**
 * Allocate a fresh, unique-within-chat tab id. Sequential `t1`, `t2`, ...
 * is short (callback_data budget is 64 bytes including namespace) and human-
 * readable in any debugging UI. We never recycle ids in a chat to avoid
 * confusion with stale callback_data still pinned to old buttons.
 */
function allocateTabId(state: ChatState): TabId {
  let next = 1;
  const taken = new Set(state.tabs.map((t) => t.id));
  while (taken.has(`t${next}`)) {
    next++;
  }
  return `t${next}`;
}

export function defaultTabLabel(state: ChatState): string {
  return `Tab ${state.tabs.length + 1}`;
}

/**
 * Hard cap on tabs per chat. Browser-tab UX cliff: more than this and the
 * panel becomes a wall of buttons, defeating the "one tap to switch" goal.
 * Beyond the cap we LRU-evict the least-recently-used non-active tab.
 */
export const MAX_TABS = 5;

/**
 * If the chat is already at MAX_TABS, evict the least-recently-used tab so
 * a new one can be added. The active tab is protected — we evict the next-
 * oldest instead. Caller already holds `state` in-place; mutation is in-place.
 */
function evictOldestIfAtCap(state: ChatState): void {
  if (state.tabs.length < MAX_TABS) {
    return;
  }
  // Sort indices by lastUsedAt ascending; skip the active tab.
  const sorted = state.tabs
    .map((t, idx) => ({ t, idx }))
    .filter(({ t }) => t.id !== state.activeTabId)
    .toSorted((a, b) => a.t.lastUsedAt - b.t.lastUsedAt);
  const victim = sorted[0];
  if (!victim) {
    return; // only the active tab exists somehow — let the caller add anyway
  }
  state.tabs.splice(victim.idx, 1);
}

export function isAutoLabel(label: string): boolean {
  return /^Tab \d+$/.test(label);
}

export function deriveLabelFromPrompt(prompt: string, max = 24): string {
  const trimmed = prompt.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export function createNewTab(key: ChatStateKey, opts?: { label?: string }): Tab {
  const state = getOrCreateChatState(key);
  evictOldestIfAtCap(state);
  const id = allocateTabId(state);
  const now = Date.now();
  const tab: Tab = {
    id,
    sessionId: null,
    label: opts?.label?.trim() || defaultTabLabel(state),
    createdAt: now,
    lastUsedAt: now,
  };
  state.tabs.push(tab);
  state.activeTabId = id;
  state.lastUsedAt = now;
  persistChatState(key, snapshot(state));
  return tab;
}

/**
 * Adopt an externally-discovered session (e.g. a jsonl from this cwd that was
 * created by a different process — VSCode IDE extension, terminal claude run,
 * etc.) as a brand-new tab. Differs from `adoptChatStateSession` (which pins
 * onto the *active* tab) by always creating a fresh tab and activating it.
 * Returns the existing tab if a tab with the same sessionId already exists
 * (idempotent) — switches active to it.
 */
export function importSessionAsTab(
  key: ChatStateKey,
  sessionId: string,
  opts?: { label?: string },
): Tab {
  const state = getOrCreateChatState(key);
  const existing = state.tabs.find((t) => t.sessionId === sessionId);
  if (existing) {
    state.activeTabId = existing.id;
    state.lastUsedAt = Date.now();
    persistChatState(key, snapshot(state));
    return existing;
  }
  evictOldestIfAtCap(state);
  const id = allocateTabId(state);
  const now = Date.now();
  const tab: Tab = {
    id,
    sessionId,
    provider: "claude",
    label: opts?.label?.trim() || defaultTabLabel(state),
    createdAt: now,
    lastUsedAt: now,
  };
  state.tabs.push(tab);
  state.activeTabId = id;
  state.lastUsedAt = now;
  persistChatState(key, snapshot(state));
  return tab;
}

export function switchActiveTab(key: ChatStateKey, tabId: TabId): boolean {
  const state = getOrCreateChatState(key);
  if (!state.tabs.some((t) => t.id === tabId)) {
    return false;
  }
  state.activeTabId = tabId;
  state.lastUsedAt = Date.now();
  persistChatState(key, snapshot(state));
  return true;
}

// ---------------------------------------------------------------------------
// Follow state — per-chat "tail -f" of a session jsonl, streamed to Telegram.
// Held in-memory only; daemon restart clears all follows. Handle is opaque
// from chat-state's perspective; follow.ts owns the interval/timeout cleanup.
// ---------------------------------------------------------------------------

export type FollowHandle = {
  sessionId: string;
  startedAt: number;
  cleanup: () => void;
};

const ACTIVE_FOLLOWS = new Map<ChatStateKey, FollowHandle>();

export function getActiveFollow(key: ChatStateKey): FollowHandle | undefined {
  return ACTIVE_FOLLOWS.get(key);
}

export function registerFollow(key: ChatStateKey, handle: FollowHandle): void {
  // Stop any previous follow for this chat — only one stream at a time.
  stopActiveFollow(key);
  ACTIVE_FOLLOWS.set(key, handle);
  // Mirror to filesystem so perm-hook.cjs (child process) can poll for the
  // "user entered session" signal and stop holding back the approval card.
  writeFollowMarker(chatIdFromChatKey(key), handle.sessionId);
}

export function stopActiveFollow(key: ChatStateKey): FollowHandle | undefined {
  const existing = ACTIVE_FOLLOWS.get(key);
  if (!existing) {
    return undefined;
  }
  ACTIVE_FOLLOWS.delete(key);
  clearFollowMarker(chatIdFromChatKey(key), existing.sessionId);
  try {
    existing.cleanup();
  } catch {
    // best-effort
  }
  return existing;
}

/**
 * Clear the active tab pointer without touching the tab list. Used by /agent
 * (no args) to render the panel in "no session selected" state — user must
 * explicitly click [N] or [+ 新 session] before plain DMs route anywhere.
 */
export function clearActiveTab(key: ChatStateKey): void {
  const state = getOrCreateChatState(key);
  if (state.activeTabId === null) {
    return;
  }
  state.activeTabId = null;
  state.lastUsedAt = Date.now();
  persistChatState(key, snapshot(state));
}

export function closeTab(key: ChatStateKey, tabId: TabId): boolean {
  const state = getOrCreateChatState(key);
  const idx = state.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) {
    return false;
  }
  state.tabs.splice(idx, 1);
  if (state.activeTabId === tabId) {
    // Promote the next tab to the right; fall back to the previous tab; if
    // none, no active tab (next plain DM creates fresh).
    const fallback = state.tabs[idx] ?? state.tabs[idx - 1] ?? null;
    state.activeTabId = fallback?.id ?? null;
  }
  state.lastUsedAt = Date.now();
  if (state.tabs.length === 0) {
    deleteChatStateInStore(key);
  } else {
    persistChatState(key, snapshot(state));
  }
  return true;
}

export function resetChatState(key: ChatStateKey): void {
  STATES.set(key, { tabs: [], activeTabId: null, lastUsedAt: Date.now() });
  deleteChatStateInStore(key);
}

/**
 * Before spawning claude for a turn, lock the active tab's label to the
 * **first** prompt seen. We do this at turn-START (not turn-END) so two
 * rapid back-to-back messages still produce a stable label regardless of
 * which claude turn returns first. No-op when the label is already manual
 * or the tab has no active value.
 */
export function seedActiveTabLabel(key: ChatStateKey, prompt: string): void {
  const state = getOrCreateChatState(key);
  const active = getActiveTab(state);
  if (!active || !isAutoLabel(active.label)) {
    return;
  }
  const derived = deriveLabelFromPrompt(prompt);
  if (!derived) {
    return;
  }
  active.label = derived;
  state.lastUsedAt = Date.now();
  persistChatState(key, snapshot(state));
}

/**
 * After a turn completes, write the new sessionId back to the **active tab**
 * (which is the tab that owned this turn). Label is handled by
 * `seedActiveTabLabel` at turn-start so it's not touched here.
 */
export function updateChatStateAfterTurn(
  key: ChatStateKey,
  sessionId: string | null,
  provider: "claude" | "codex" | "gemini" = "claude",
): void {
  const state = getOrCreateChatState(key);
  const active = getActiveTab(state);
  if (!active) {
    state.lastUsedAt = Date.now();
    return;
  }
  const priorProvider = active.provider ?? (active.sessionId ? "claude" : undefined);
  if (priorProvider && priorProvider !== provider) {
    active.sessionId = null;
  }
  active.provider = provider;
  if (sessionId) {
    active.sessionId = sessionId;
  }
  active.lastUsedAt = Date.now();
  state.lastUsedAt = active.lastUsedAt;
  persistChatState(key, snapshot(state));
}

/**
 * Pin the active tab's session to an externally-discovered id (used by
 * `/agent continue`). Differs from updateChatStateAfterTurn by being a
 * deliberate user-initiated swap.
 */
export function adoptChatStateSession(key: ChatStateKey, sessionId: string): void {
  const state = getOrCreateChatState(key);
  let active = getActiveTab(state);
  if (!active) {
    // No active tab to adopt into — create one first so the next DM resumes.
    active = createNewTab(key);
    // createNewTab already persisted; now overwrite sessionId.
  }
  active.sessionId = sessionId;
  active.provider = "claude";
  active.lastUsedAt = Date.now();
  state.lastUsedAt = active.lastUsedAt;
  persistChatState(key, snapshot(state));
}

/**
 * Hydrate the in-memory map from the persistent store. Called once at plugin
 * register. Detects legacy P5 records and migrates inline. Existing in-memory
 * entries win to avoid clobbering live state across hot reload.
 */
export async function hydrateChatStatesFromStore(): Promise<number> {
  const persisted = await loadAllChatStates();
  let restored = 0;
  for (const [key, record] of persisted) {
    if (STATES.has(key)) {
      continue;
    }
    STATES.set(key, fromPersisted(record));
    restored++;
  }
  return restored;
}

export function clearAllChatStatesForTesting(): void {
  STATES.clear();
}

// ---------------------------------------------------------------------------
// Persistence shape mapping
// ---------------------------------------------------------------------------

function snapshot(state: ChatState): PersistedChatStateRecord {
  return {
    tabs: state.tabs.map((t) => ({ ...t })),
    activeTabId: state.activeTabId,
    lastUsedAt: state.lastUsedAt,
  };
}

function fromPersisted(record: PersistedChatStateRecord): ChatState {
  // Strict routing (2026-05-12): never restore `activeTabId` across daemon
  // restart. The user must explicitly re-enter a session via `/agent`
  // panel ([N] switch / [+ 新 session]) or the approval-nudge `[👁 进入]`
  // button before plain DMs route to a agent session. Reason: the user
  // opens Telegram fresh and expects to consciously choose where their
  // message goes, not have it silently land in whatever was active last
  // session. Tabs (session metadata) still hydrate so the `/agent` panel
  // can list recent sessions to pick from.
  if (Array.isArray(record.tabs)) {
    return {
      tabs: record.tabs.map((t) => ({ ...t })),
      activeTabId: null,
      lastUsedAt: record.lastUsedAt,
    };
  }
  // Legacy v1 record: { sessionId, lastUsedAt } — migrate to a single tab.
  // Same strict rule: tab is present in the pool, but not active.
  const legacy = record as unknown as { sessionId: string | null; lastUsedAt: number };
  if (legacy.sessionId) {
    return {
      tabs: [
        {
          id: "t1",
          sessionId: legacy.sessionId,
          label: "Tab 1",
          createdAt: legacy.lastUsedAt,
          lastUsedAt: legacy.lastUsedAt,
        },
      ],
      activeTabId: null,
      lastUsedAt: legacy.lastUsedAt,
    };
  }
  return { tabs: [], activeTabId: null, lastUsedAt: legacy.lastUsedAt };
}

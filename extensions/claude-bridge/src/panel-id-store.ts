// Per-chat "current /claude panel" message id store.
//
// Goal: the /claude tab manager UI exists as exactly ONE message in the chat
// at any time. Every interaction (switch, newTab, follow, unfollow,
// enterAndFollow…) edits that one message in place. Re-issuing /claude
// finds the prior panel, deletes it, and posts a fresh one (or just edits
// it — both flows persist the new message id here).
//
// Why an explicit store: callback paths (interactive.ts) get the panel
// message id "for free" via the Telegram callback context, but the command
// path (command.ts) doesn't — when the user types /claude again there is
// no callback context, only a freshly-spawned command turn. Persisting the
// id lets command.ts find the prior panel and reuse / replace it instead
// of dropping a new one each turn.
//
// Same hydrate-once-then-write-through pattern as chat-state-store.ts.

import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

export type PanelIdRecord = {
  /** Telegram chat id where the panel lives (the DM chat, not the forum group). */
  chatId: string;
  /** Telegram message_id of the panel message. */
  messageId: number;
  /** Last time we wrote or refreshed this panel. */
  updatedAt: number;
};

const STORE_NAMESPACE = "claude-bridge.panel-id";
const STORE_MAX_ENTRIES = 500;

type PanelIdStore = {
  register(key: string, value: PanelIdRecord, opts?: { ttlMs?: number }): Promise<void>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<{ key: string; value: PanelIdRecord }[]>;
};

const PANELS = new Map<string, PanelIdRecord>();

let runtimeRef: PluginRuntime | undefined;
let cachedStore: PanelIdStore | undefined;
let storeDisabled = false;
let testStoreOverride: PanelIdStore | null | undefined;

export function setPanelIdRuntime(runtime: PluginRuntime | undefined): void {
  runtimeRef = runtime;
  cachedStore = undefined;
  storeDisabled = false;
}

export function setPanelIdStoreForTesting(store: PanelIdStore | null | undefined): void {
  testStoreOverride = store;
  cachedStore = undefined;
  storeDisabled = false;
}

export function resetPanelIdStoreForTesting(): void {
  runtimeRef = undefined;
  cachedStore = undefined;
  storeDisabled = false;
  testStoreOverride = undefined;
  PANELS.clear();
}

function getStore(): PanelIdStore | undefined {
  if (testStoreOverride !== undefined) {
    return testStoreOverride ?? undefined;
  }
  if (storeDisabled) return undefined;
  if (cachedStore) return cachedStore;
  if (!runtimeRef) return undefined;
  try {
    cachedStore = runtimeRef.state.openKeyedStore<PanelIdRecord>({
      namespace: STORE_NAMESPACE,
      maxEntries: STORE_MAX_ENTRIES,
    });
    return cachedStore;
  } catch (error) {
    disable(error, "open");
    return undefined;
  }
}

function disable(error: unknown, op: string): void {
  storeDisabled = true;
  cachedStore = undefined;
  try {
    runtimeRef?.logging
      .getChildLogger({ plugin: "claude-bridge", feature: "panel-id-store" })
      .warn("claude-bridge panel-id store disabled", { op, error: String(error) });
  } catch {
    // observability is best-effort
  }
}

export async function hydratePanelIdsFromStore(): Promise<void> {
  const store = getStore();
  if (!store) return;
  try {
    const rows = await store.entries();
    PANELS.clear();
    for (const row of rows) {
      PANELS.set(row.key, row.value);
    }
  } catch (error) {
    disable(error, "entries");
  }
}

/** Synchronous lookup — uses the hydrated in-memory cache. */
export function getPanelId(chatKey: string): PanelIdRecord | undefined {
  return PANELS.get(chatKey);
}

/** Update in-memory cache + fire-and-forget persist. */
export function setPanelId(chatKey: string, record: PanelIdRecord): void {
  PANELS.set(chatKey, record);
  const store = getStore();
  if (!store) return;
  void store.register(chatKey, record).catch((error) => disable(error, "register"));
}

export function clearPanelId(chatKey: string): void {
  PANELS.delete(chatKey);
  const store = getStore();
  if (!store) return;
  void store.delete(chatKey).catch((error) => disable(error, "delete"));
}

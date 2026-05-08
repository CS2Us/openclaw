// Persistent backing for the in-memory chat-state Map. Uses the SQLite-backed
// `runtime.state.openKeyedStore` seam (same pattern as msteams sent-message
// cache, slack thread cache, discord components registry) so plain DM session
// continuity survives daemon restart.
//
// The in-memory `STATES` Map in chat-state.ts stays the synchronous source of
// truth for the bridge's hot path. This module is a write-through mirror:
//   - on plugin init, `loadAllChatStates()` reads everything once into memory
//   - on every mutation in chat-state.ts, a fire-and-forget `persistChatState`
//     write hits the store
// Errors disable the persistent layer (warn via plugin logger) without ever
// breaking the bridge — chat-state semantics degrade gracefully back to v1
// in-memory only.
//
// Why not `registerSessionExtension`: that seam projects per-Gateway-session
// state into a session row; chat-state is keyed on `${channel}:${chatId}`
// (which has no Gateway-session lifecycle binding) and we want the value to
// outlive every Gateway session this chat may have spawned.

import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

export type PersistedTab = {
  id: string;
  sessionId: string | null;
  label: string;
  createdAt: number;
  lastUsedAt: number;
};

/**
 * Persisted shape. Forward-only fields are optional so legacy P5 records
 * (`{ sessionId, lastUsedAt }`) parse without error and migrate at read-time
 * in `chat-state.ts`'s `fromPersisted`. Once migrated, every subsequent write
 * is in the v2 shape.
 */
export type PersistedChatStateRecord = {
  tabs?: PersistedTab[];
  activeTabId?: string | null;
  lastUsedAt: number;
  // Legacy v1 fallback — keep on the type so loaders don't trip up before
  // migration. New writes never set this.
  sessionId?: string | null;
};

const STORE_NAMESPACE = "claude-bridge.chat-state";
const STORE_MAX_ENTRIES = 500;

// Narrow local view of the SDK keyed-store contract — mirrors the pattern
// msteams/slack use so we avoid importing internal plugin-state types.
export type ChatStateStore = {
  register(key: string, value: PersistedChatStateRecord, opts?: { ttlMs?: number }): Promise<void>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<{ key: string; value: PersistedChatStateRecord }[]>;
};

let runtimeRef: PluginRuntime | undefined;
let cachedStore: ChatStateStore | undefined;
let storeDisabled = false;
let testStoreOverride: ChatStateStore | null | undefined;

export function setClaudeBridgeRuntime(runtime: PluginRuntime | undefined): void {
  runtimeRef = runtime;
  cachedStore = undefined;
  storeDisabled = false;
}

export function setChatStateStoreForTesting(store: ChatStateStore | null | undefined): void {
  testStoreOverride = store;
  cachedStore = undefined;
  storeDisabled = false;
}

function getStore(): ChatStateStore | undefined {
  if (testStoreOverride !== undefined) {
    return testStoreOverride ?? undefined;
  }
  if (storeDisabled) {
    return undefined;
  }
  if (cachedStore) {
    return cachedStore;
  }
  if (!runtimeRef) {
    return undefined;
  }
  try {
    cachedStore = runtimeRef.state.openKeyedStore<PersistedChatStateRecord>({
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
      .getChildLogger({ plugin: "claude-bridge", feature: "chat-state-store" })
      .warn("claude-bridge chat-state persistence disabled", {
        op,
        error: String(error),
      });
  } catch {
    // logging best-effort: never let observability break the bridge.
  }
}

export async function loadAllChatStates(): Promise<Map<string, PersistedChatStateRecord>> {
  const out = new Map<string, PersistedChatStateRecord>();
  const store = getStore();
  if (!store) {
    return out;
  }
  try {
    const entries = await store.entries();
    for (const entry of entries) {
      out.set(entry.key, entry.value);
    }
    return out;
  } catch (error) {
    disable(error, "entries");
    return out;
  }
}

export function persistChatState(key: string, record: PersistedChatStateRecord): void {
  const store = getStore();
  if (!store) {
    return;
  }
  void store.register(key, record).catch((error) => disable(error, "register"));
}

export function deleteChatStateInStore(key: string): void {
  const store = getStore();
  if (!store) {
    return;
  }
  void store.delete(key).catch((error) => disable(error, "delete"));
}

export function isChatStateStoreDisabledForTesting(): boolean {
  return storeDisabled;
}

export function resetChatStateStoreForTesting(): void {
  runtimeRef = undefined;
  cachedStore = undefined;
  storeDisabled = false;
  testStoreOverride = undefined;
}

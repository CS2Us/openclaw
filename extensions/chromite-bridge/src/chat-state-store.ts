// Persistent backing for chromite-bridge per-chat session state.
// sub-spec chromite-harness-openclaw-bridge-v1 §3 决策 #C.
//
// Pattern: 仿 claude-bridge chat-state-store —— runtime.state.openKeyedStore
// 提供 namespaced KV，启动时 hydrate 进内存表，写改 fire-and-forget mirror。
//
// 失败降级：store 不可用 → in-memory only（chromite_chat_id↔session_id 映射
// 进程内可用，restart 丢失重新生成）。绝不让 store 错误中断 bridge 主路径。

import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const STORE_NAMESPACE = "chromite-bridge:chat-state:v1";
const STORE_MAX_ENTRIES = 10_000;

/** Persisted shape v1. */
export type PersistedChatState = {
  /** chromite session UUID (passed back to chromite chat endpoint). */
  sessionId: string;
  /** Unix ms of first generation. */
  createdAt: number;
  /** Unix ms of last successful chromite chat round. */
  lastUsedAt: number;
};

/** Tiny structural subset of `runtime.state.openKeyedStore` we use. */
type ChatStateStore = {
  entries(): Promise<Array<{ key: string; value: PersistedChatState }>>;
  set(key: string, value: PersistedChatState): Promise<void>;
  delete(key: string): Promise<void>;
};

let runtimeRef: PluginRuntime | undefined;
let cachedStore: ChatStateStore | undefined;
let storeDisabled = false;
let testStoreOverride: ChatStateStore | null | undefined;

export function setChromiteBridgeRuntime(runtime: PluginRuntime | undefined): void {
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
    cachedStore = runtimeRef.state.openKeyedStore<PersistedChatState>({
      namespace: STORE_NAMESPACE,
      maxEntries: STORE_MAX_ENTRIES,
    }) as unknown as ChatStateStore;
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
      .getChildLogger({ plugin: "chromite-bridge", feature: "chat-state-store" })
      .warn("chromite-bridge chat-state persistence disabled", {
        op,
        error: String(error),
      });
  } catch {
    // logging best-effort
  }
}

export async function loadAllChatStates(): Promise<Map<string, PersistedChatState>> {
  const out = new Map<string, PersistedChatState>();
  const store = getStore();
  if (!store) return out;
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

export async function persistChatState(key: string, value: PersistedChatState): Promise<void> {
  const store = getStore();
  if (!store) return;
  try {
    await store.set(key, value);
  } catch (error) {
    disable(error, "set");
  }
}

export async function deleteChatState(key: string): Promise<void> {
  const store = getStore();
  if (!store) return;
  try {
    await store.delete(key);
  } catch (error) {
    disable(error, "delete");
  }
}

// Persistent backing for relay-push pending subscriptions.
// spec chromite-relay-push-consumer-v1 — the pay→confirm window can span a
// daemon restart; losing the subscription only degrades to "no push" (the
// trade itself is unaffected), so this mirrors the chat-state-store pattern:
// runtime.state.openKeyedStore namespaced KV, hydrate at register, write
// fire-and-forget, disable itself on failure. Never blocks the push path.

import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import type { PendingSubscription } from "./relay-push.js";

const STORE_NAMESPACE = "chromite-bridge:relay-push:v1";
const STORE_MAX_ENTRIES = 5_000;

/** Tiny structural subset of `runtime.state.openKeyedStore` we use. */
type PendingSubscriptionStore = {
  entries(): Promise<Array<{ key: string; value: PendingSubscription }>>;
  set(key: string, value: PendingSubscription): Promise<void>;
  delete(key: string): Promise<void>;
};

let runtimeRef: PluginRuntime | undefined;
let cachedStore: PendingSubscriptionStore | undefined;
let storeDisabled = false;
let testStoreOverride: PendingSubscriptionStore | null | undefined;

export function setRelayPushStoreRuntime(runtime: PluginRuntime | undefined): void {
  runtimeRef = runtime;
  cachedStore = undefined;
  storeDisabled = false;
}

export function setRelayPushStoreForTesting(
  store: PendingSubscriptionStore | null | undefined,
): void {
  testStoreOverride = store;
  cachedStore = undefined;
  storeDisabled = false;
}

function getStore(): PendingSubscriptionStore | undefined {
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
    cachedStore = runtimeRef.state.openKeyedStore<PendingSubscription>({
      namespace: STORE_NAMESPACE,
      maxEntries: STORE_MAX_ENTRIES,
    }) as unknown as PendingSubscriptionStore;
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
      .getChildLogger({ plugin: "chromite-bridge", feature: "relay-push-store" })
      .warn("chromite-bridge relay-push persistence disabled", {
        op,
        error: String(error),
      });
  } catch {
    // logging best-effort
  }
}

export async function loadAllPendingSubscriptions(): Promise<PendingSubscription[]> {
  const store = getStore();
  if (!store) return [];
  try {
    const entries = await store.entries();
    return entries.map((entry) => entry.value);
  } catch (error) {
    disable(error, "entries");
    return [];
  }
}

export async function persistPendingSubscription(sub: PendingSubscription): Promise<void> {
  const store = getStore();
  if (!store) return;
  try {
    await store.set(sub.orderId, sub);
  } catch (error) {
    disable(error, "set");
  }
}

export async function deletePendingSubscription(orderId: string): Promise<void> {
  const store = getStore();
  if (!store) return;
  try {
    await store.delete(orderId);
  } catch (error) {
    disable(error, "delete");
  }
}

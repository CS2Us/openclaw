import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ChatStateStore,
  isChatStateStoreDisabledForTesting,
  loadAllChatStates,
  persistChatState,
  resetChatStateStoreForTesting,
  setChatStateStoreForTesting,
  deleteChatStateInStore,
} from "./chat-state-store.js";

type Entry = { key: string; value: { sessionId: string | null; lastUsedAt: number } };

function createFakeStore(initial: Entry[] = []) {
  const data = new Map<string, Entry["value"]>();
  for (const e of initial) {
    data.set(e.key, e.value);
  }
  const calls = {
    register: vi.fn(),
    delete: vi.fn(),
    entries: vi.fn(),
  };
  const store: ChatStateStore = {
    async register(key, value) {
      calls.register(key, value);
      data.set(key, value);
    },
    async delete(key) {
      calls.delete(key);
      return data.delete(key);
    },
    async entries() {
      calls.entries();
      return Array.from(data.entries()).map(([key, value]) => ({ key, value }));
    },
  };
  return { store, calls, data };
}

beforeEach(() => {
  resetChatStateStoreForTesting();
});

afterEach(() => {
  resetChatStateStoreForTesting();
});

describe("loadAllChatStates", () => {
  it("returns empty map when no store is configured", async () => {
    const out = await loadAllChatStates();
    expect(out.size).toBe(0);
  });

  it("reads every persisted entry into a map keyed by chatStateKey", async () => {
    const { store } = createFakeStore([
      { key: "telegram:1", value: { sessionId: "abc", lastUsedAt: 100 } },
      { key: "telegram:2", value: { sessionId: null, lastUsedAt: 200 } },
    ]);
    setChatStateStoreForTesting(store);

    const out = await loadAllChatStates();
    expect(out.size).toBe(2);
    expect(out.get("telegram:1")).toEqual({ sessionId: "abc", lastUsedAt: 100 });
    expect(out.get("telegram:2")).toEqual({ sessionId: null, lastUsedAt: 200 });
  });

  it("disables the store and returns an empty map when entries() throws", async () => {
    const failing: ChatStateStore = {
      async register() {},
      async delete() {
        return false;
      },
      async entries() {
        throw new Error("sqlite is unavailable");
      },
    };
    setChatStateStoreForTesting(failing);

    const out = await loadAllChatStates();
    expect(out.size).toBe(0);
    expect(isChatStateStoreDisabledForTesting()).toBe(true);
  });
});

describe("persistChatState", () => {
  it("registers the value under the given key", async () => {
    const { store, calls } = createFakeStore();
    setChatStateStoreForTesting(store);

    persistChatState("telegram:7", { sessionId: "ses-7", lastUsedAt: 555 });
    // fire-and-forget: drain the microtask queue to flush the underlying
    // Promise chain.
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.register).toHaveBeenCalledWith("telegram:7", {
      sessionId: "ses-7",
      lastUsedAt: 555,
    });
  });

  it("disables the store on register error and never throws to the caller", async () => {
    const failing: ChatStateStore = {
      async register() {
        throw new Error("write failed");
      },
      async delete() {
        return false;
      },
      async entries() {
        return [];
      },
    };
    setChatStateStoreForTesting(failing);

    expect(() => persistChatState("telegram:9", { sessionId: "x", lastUsedAt: 1 })).not.toThrow();

    // Let the rejection propagate through the .catch().
    await Promise.resolve();
    await Promise.resolve();
    expect(isChatStateStoreDisabledForTesting()).toBe(true);
  });

  it("is a no-op when no store is configured", () => {
    // No setChatStateStoreForTesting call → getStore() returns undefined.
    expect(() => persistChatState("telegram:7", { sessionId: "x", lastUsedAt: 1 })).not.toThrow();
  });
});

describe("deleteChatStateInStore", () => {
  it("removes the persisted entry", async () => {
    const { store, calls, data } = createFakeStore([
      { key: "telegram:1", value: { sessionId: "abc", lastUsedAt: 100 } },
    ]);
    setChatStateStoreForTesting(store);

    deleteChatStateInStore("telegram:1");
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.delete).toHaveBeenCalledWith("telegram:1");
    expect(data.has("telegram:1")).toBe(false);
  });
});

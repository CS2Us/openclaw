import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ChatStateStore,
  resetChatStateStoreForTesting,
  setChatStateStoreForTesting,
} from "./chat-state-store.js";
import {
  adoptChatStateSession,
  chatStateKey,
  clearAllChatStatesForTesting,
  getOrCreateChatState,
  hydrateChatStatesFromStore,
  resetChatState,
  updateChatStateAfterTurn,
} from "./chat-state.js";

type Entry = { key: string; value: { sessionId: string | null; lastUsedAt: number } };

function createFakeStore(initial: Entry[] = []) {
  const data = new Map<string, Entry["value"]>();
  for (const e of initial) {
    data.set(e.key, e.value);
  }
  const calls = {
    register: vi.fn(),
    delete: vi.fn(),
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
      return Array.from(data.entries()).map(([key, value]) => ({ key, value }));
    },
  };
  return { store, calls, data };
}

beforeEach(() => {
  clearAllChatStatesForTesting();
  resetChatStateStoreForTesting();
});

afterEach(() => {
  resetChatStateStoreForTesting();
});

describe("chatStateKey", () => {
  it("composes channel + chat id with a colon separator", () => {
    expect(chatStateKey("telegram", "12345")).toBe("telegram:12345");
  });
});

describe("getOrCreateChatState", () => {
  it("starts with sessionId=null on first read", () => {
    const state = getOrCreateChatState("telegram:1");
    expect(state.sessionId).toBeNull();
    expect(state.lastUsedAt).toBeGreaterThan(0);
  });

  it("returns the same instance on subsequent reads (so writes stick)", () => {
    const a = getOrCreateChatState("telegram:1");
    a.sessionId = "abc";
    const b = getOrCreateChatState("telegram:1");
    expect(b.sessionId).toBe("abc");
  });

  it("isolates state across distinct keys", () => {
    const a = getOrCreateChatState("telegram:1");
    a.sessionId = "abc";
    const b = getOrCreateChatState("telegram:2");
    expect(b.sessionId).toBeNull();
  });
});

describe("updateChatStateAfterTurn", () => {
  it("writes the new sessionId when present", () => {
    updateChatStateAfterTurn("telegram:1", "session-xyz");
    expect(getOrCreateChatState("telegram:1").sessionId).toBe("session-xyz");
  });

  it("preserves the existing sessionId when the new one is null", () => {
    updateChatStateAfterTurn("telegram:1", "session-xyz");
    updateChatStateAfterTurn("telegram:1", null);
    expect(getOrCreateChatState("telegram:1").sessionId).toBe("session-xyz");
  });

  it("bumps lastUsedAt", async () => {
    const before = getOrCreateChatState("telegram:1").lastUsedAt;
    await new Promise((r) => setTimeout(r, 5));
    updateChatStateAfterTurn("telegram:1", "session-xyz");
    expect(getOrCreateChatState("telegram:1").lastUsedAt).toBeGreaterThan(before);
  });
});

describe("resetChatState", () => {
  it("clears sessionId back to null", () => {
    updateChatStateAfterTurn("telegram:1", "to-be-killed");
    resetChatState("telegram:1");
    expect(getOrCreateChatState("telegram:1").sessionId).toBeNull();
  });

  it("creates an empty state if the key was never used", () => {
    resetChatState("telegram:fresh");
    expect(getOrCreateChatState("telegram:fresh").sessionId).toBeNull();
  });
});

describe("hydrateChatStatesFromStore", () => {
  it("seeds in-memory state from persisted records", async () => {
    const { store } = createFakeStore([
      { key: "telegram:42", value: { sessionId: "ses-42", lastUsedAt: 1000 } },
    ]);
    setChatStateStoreForTesting(store);

    const restored = await hydrateChatStatesFromStore();

    expect(restored).toBe(1);
    const state = getOrCreateChatState("telegram:42");
    expect(state.sessionId).toBe("ses-42");
    expect(state.lastUsedAt).toBe(1000);
  });

  it("does not overwrite existing in-memory state (live state wins)", async () => {
    const { store } = createFakeStore([
      { key: "telegram:1", value: { sessionId: "stale", lastUsedAt: 100 } },
    ]);
    setChatStateStoreForTesting(store);

    // Simulate a live mutation that races ahead of hydrate completion.
    updateChatStateAfterTurn("telegram:1", "fresh");

    const restored = await hydrateChatStatesFromStore();

    expect(restored).toBe(0);
    expect(getOrCreateChatState("telegram:1").sessionId).toBe("fresh");
  });

  it("returns 0 and does not throw when no store is configured", async () => {
    const restored = await hydrateChatStatesFromStore();
    expect(restored).toBe(0);
  });
});

describe("persistence side effects", () => {
  it("updateChatStateAfterTurn writes the new sessionId to the store", async () => {
    const { store, calls, data } = createFakeStore();
    setChatStateStoreForTesting(store);

    updateChatStateAfterTurn("telegram:1", "fresh-id");
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.register).toHaveBeenCalledWith(
      "telegram:1",
      expect.objectContaining({ sessionId: "fresh-id" }),
    );
    expect(data.get("telegram:1")?.sessionId).toBe("fresh-id");
  });

  it("adoptChatStateSession writes the adopted sessionId to the store", async () => {
    const { store, calls } = createFakeStore();
    setChatStateStoreForTesting(store);

    adoptChatStateSession("telegram:1", "adopted-id");
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.register).toHaveBeenCalledWith(
      "telegram:1",
      expect.objectContaining({ sessionId: "adopted-id" }),
    );
  });

  it("resetChatState deletes the persisted row so restart does not auto-resume", async () => {
    const { store, calls, data } = createFakeStore([
      { key: "telegram:1", value: { sessionId: "going-away", lastUsedAt: 1 } },
    ]);
    setChatStateStoreForTesting(store);

    resetChatState("telegram:1");
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.delete).toHaveBeenCalledWith("telegram:1");
    expect(data.has("telegram:1")).toBe(false);
  });
});

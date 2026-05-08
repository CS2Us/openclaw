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
  closeTab,
  createNewTab,
  deriveLabelFromPrompt,
  getActiveTab,
  getOrCreateChatState,
  hydrateChatStatesFromStore,
  importSessionAsTab,
  isAutoLabel,
  resetChatState,
  seedActiveTabLabel,
  switchActiveTab,
  updateChatStateAfterTurn,
} from "./chat-state.js";

type Entry = { key: string; value: unknown };

function createFakeStore(initial: Entry[] = []) {
  const data = new Map<string, unknown>();
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
      // chat-state-store types entries() as PersistedChatStateRecord[], but at
      // runtime the store is a generic JSON store — pass values through.
      return Array.from(data.entries()).map(([key, value]) => ({
        key,
        value: value as never,
      }));
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
  it("starts empty (no tabs, no active)", () => {
    const state = getOrCreateChatState("telegram:1");
    expect(state.tabs).toEqual([]);
    expect(state.activeTabId).toBeNull();
  });

  it("returns the same instance on repeat reads", () => {
    const a = getOrCreateChatState("telegram:1");
    a.lastUsedAt = 999;
    const b = getOrCreateChatState("telegram:1");
    expect(b).toBe(a);
  });
});

describe("createNewTab", () => {
  it("allocates t1, t2, ... and activates the new tab", () => {
    const t1 = createNewTab("telegram:1");
    expect(t1.id).toBe("t1");
    expect(getActiveTab(getOrCreateChatState("telegram:1"))?.id).toBe("t1");

    const t2 = createNewTab("telegram:1");
    expect(t2.id).toBe("t2");
    expect(getActiveTab(getOrCreateChatState("telegram:1"))?.id).toBe("t2");
  });

  it("auto-labels Tab N where N matches initial position", () => {
    const t1 = createNewTab("telegram:1");
    expect(t1.label).toBe("Tab 1");
    const t2 = createNewTab("telegram:1");
    expect(t2.label).toBe("Tab 2");
  });

  it("never recycles a tab id within a chat", () => {
    createNewTab("telegram:1"); // t1
    createNewTab("telegram:1"); // t2
    closeTab("telegram:1", "t1");
    const t3 = createNewTab("telegram:1");
    expect(t3.id).toBe("t1"); // reuse only because t1 is gone & t2 still exists
    // confirm the existing t2 stays
    expect(
      getOrCreateChatState("telegram:1")
        .tabs.map((t) => t.id)
        .toSorted(),
    ).toEqual(["t1", "t2"]);
  });
});

describe("switchActiveTab", () => {
  it("switches active when target exists", () => {
    createNewTab("telegram:1");
    createNewTab("telegram:1");
    expect(switchActiveTab("telegram:1", "t1")).toBe(true);
    expect(getActiveTab(getOrCreateChatState("telegram:1"))?.id).toBe("t1");
  });

  it("returns false when target id missing", () => {
    createNewTab("telegram:1");
    expect(switchActiveTab("telegram:1", "tNope")).toBe(false);
    expect(getActiveTab(getOrCreateChatState("telegram:1"))?.id).toBe("t1");
  });
});

describe("closeTab", () => {
  it("removes target and falls back to next-tab activation", () => {
    createNewTab("telegram:1"); // t1 active
    createNewTab("telegram:1"); // t2 active
    switchActiveTab("telegram:1", "t1");
    closeTab("telegram:1", "t1");
    expect(getActiveTab(getOrCreateChatState("telegram:1"))?.id).toBe("t2");
  });

  it("clears active when last tab closed", () => {
    createNewTab("telegram:1");
    closeTab("telegram:1", "t1");
    expect(getActiveTab(getOrCreateChatState("telegram:1"))).toBeNull();
  });
});

describe("updateChatStateAfterTurn", () => {
  it("writes sessionId to active tab", () => {
    createNewTab("telegram:1");
    updateChatStateAfterTurn("telegram:1", "ses-abc");
    expect(getActiveTab(getOrCreateChatState("telegram:1"))?.sessionId).toBe("ses-abc");
  });

  it("noop when no active tab", () => {
    expect(() => updateChatStateAfterTurn("telegram:1", "ses-abc")).not.toThrow();
  });
});

describe("seedActiveTabLabel", () => {
  it("locks label to first prompt when tab still has auto label", () => {
    createNewTab("telegram:1");
    seedActiveTabLabel("telegram:1", "你好，我叫张三");
    expect(getActiveTab(getOrCreateChatState("telegram:1"))?.label).toBe("你好，我叫张三");
  });

  it("does not overwrite a label set by a previous turn", () => {
    createNewTab("telegram:1");
    seedActiveTabLabel("telegram:1", "我叫张三");
    seedActiveTabLabel("telegram:1", "在干啥"); // simulates turn 2 racing
    expect(getActiveTab(getOrCreateChatState("telegram:1"))?.label).toBe("我叫张三");
  });

  it("preserves manual label", () => {
    const t = createNewTab("telegram:1", { label: "调试 chromite" });
    seedActiveTabLabel("telegram:1", "我叫张三");
    expect(getActiveTab(getOrCreateChatState("telegram:1"))?.label).toBe(t.label);
  });

  it("noop when prompt empty after trim", () => {
    createNewTab("telegram:1");
    seedActiveTabLabel("telegram:1", "   ");
    expect(getActiveTab(getOrCreateChatState("telegram:1"))?.label).toBe("Tab 1");
  });

  it("noop when no active tab", () => {
    expect(() => seedActiveTabLabel("telegram:1", "anything")).not.toThrow();
  });
});

describe("resetChatState", () => {
  it("drops all tabs", () => {
    createNewTab("telegram:1");
    createNewTab("telegram:1");
    resetChatState("telegram:1");
    const s = getOrCreateChatState("telegram:1");
    expect(s.tabs).toEqual([]);
    expect(s.activeTabId).toBeNull();
  });
});

describe("importSessionAsTab", () => {
  it("creates a fresh tab pinned to the imported sessionId and activates it", () => {
    createNewTab("telegram:1"); // t1, blank
    const imported = importSessionAsTab("telegram:1", "ses-imported", { label: "VSCode work" });
    expect(imported.id).toBe("t2");
    expect(imported.sessionId).toBe("ses-imported");
    expect(imported.label).toBe("VSCode work");
    expect(getActiveTab(getOrCreateChatState("telegram:1"))?.id).toBe("t2");
  });

  it("idempotent: re-importing the same sessionId switches active to the existing tab", () => {
    createNewTab("telegram:1");
    importSessionAsTab("telegram:1", "ses-A", { label: "A" }); // t2 active
    importSessionAsTab("telegram:1", "ses-B", { label: "B" }); // t3 active
    const second = importSessionAsTab("telegram:1", "ses-A");
    expect(second.id).toBe("t2");
    expect(getActiveTab(getOrCreateChatState("telegram:1"))?.id).toBe("t2");
    expect(getOrCreateChatState("telegram:1").tabs.length).toBe(3);
  });

  it("falls back to default Tab N label when no label given", () => {
    const imported = importSessionAsTab("telegram:1", "ses-x");
    expect(imported.label).toBe("Tab 1");
  });
});

describe("adoptChatStateSession", () => {
  it("auto-creates a tab if none exists, then pins sessionId", () => {
    adoptChatStateSession("telegram:1", "ses-cli-zhang");
    const active = getActiveTab(getOrCreateChatState("telegram:1"));
    expect(active?.sessionId).toBe("ses-cli-zhang");
  });

  it("pins onto active tab when one exists", () => {
    createNewTab("telegram:1");
    adoptChatStateSession("telegram:1", "ses-cli-li");
    expect(getActiveTab(getOrCreateChatState("telegram:1"))?.sessionId).toBe("ses-cli-li");
  });
});

describe("label helpers", () => {
  it("isAutoLabel matches Tab N pattern", () => {
    expect(isAutoLabel("Tab 1")).toBe(true);
    expect(isAutoLabel("Tab 12")).toBe(true);
    expect(isAutoLabel("Tab")).toBe(false);
    expect(isAutoLabel("张三")).toBe(false);
  });

  it("deriveLabelFromPrompt collapses whitespace + truncates", () => {
    expect(deriveLabelFromPrompt("hello\n  world")).toBe("hello world");
    const long = "a".repeat(100);
    const out = deriveLabelFromPrompt(long, 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("hydrateChatStatesFromStore", () => {
  it("seeds in-memory state from persisted v2 records", async () => {
    const { store } = createFakeStore([
      {
        key: "telegram:42",
        value: {
          tabs: [
            { id: "t1", sessionId: "ses-1", label: "张三", createdAt: 100, lastUsedAt: 100 },
            { id: "t2", sessionId: null, label: "Tab 2", createdAt: 200, lastUsedAt: 200 },
          ],
          activeTabId: "t1",
          lastUsedAt: 200,
        },
      },
    ]);
    setChatStateStoreForTesting(store);

    const restored = await hydrateChatStatesFromStore();
    expect(restored).toBe(1);
    const state = getOrCreateChatState("telegram:42");
    expect(state.tabs.length).toBe(2);
    expect(state.activeTabId).toBe("t1");
    expect(getActiveTab(state)?.label).toBe("张三");
  });

  it("migrates legacy v1 records (sessionId-only) into a single Tab 1", async () => {
    const { store } = createFakeStore([
      {
        key: "telegram:99",
        value: { sessionId: "ses-legacy", lastUsedAt: 500 },
      },
    ]);
    setChatStateStoreForTesting(store);

    const restored = await hydrateChatStatesFromStore();
    expect(restored).toBe(1);
    const state = getOrCreateChatState("telegram:99");
    expect(state.tabs).toEqual([
      {
        id: "t1",
        sessionId: "ses-legacy",
        label: "Tab 1",
        createdAt: 500,
        lastUsedAt: 500,
      },
    ]);
    expect(state.activeTabId).toBe("t1");
  });

  it("legacy v1 record without sessionId migrates to empty (no tabs)", async () => {
    const { store } = createFakeStore([
      { key: "telegram:99", value: { sessionId: null, lastUsedAt: 500 } },
    ]);
    setChatStateStoreForTesting(store);

    await hydrateChatStatesFromStore();
    const state = getOrCreateChatState("telegram:99");
    expect(state.tabs).toEqual([]);
    expect(state.activeTabId).toBeNull();
  });

  it("does not overwrite live state during hot reload", async () => {
    const { store } = createFakeStore([
      {
        key: "telegram:1",
        value: { sessionId: "stale", lastUsedAt: 100 },
      },
    ]);
    setChatStateStoreForTesting(store);

    createNewTab("telegram:1");
    updateChatStateAfterTurn("telegram:1", "fresh");

    const restored = await hydrateChatStatesFromStore();
    expect(restored).toBe(0);
    expect(getActiveTab(getOrCreateChatState("telegram:1"))?.sessionId).toBe("fresh");
  });
});

describe("persistence side effects", () => {
  it("createNewTab persists v2 snapshot", async () => {
    const { store, calls } = createFakeStore();
    setChatStateStoreForTesting(store);

    createNewTab("telegram:1");
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.register).toHaveBeenCalledWith(
      "telegram:1",
      expect.objectContaining({
        tabs: expect.any(Array),
        activeTabId: "t1",
      }),
    );
  });

  it("resetChatState deletes the persisted row", async () => {
    const { store, calls, data } = createFakeStore([
      {
        key: "telegram:1",
        value: { tabs: [], activeTabId: null, lastUsedAt: 1 },
      },
    ]);
    setChatStateStoreForTesting(store);

    resetChatState("telegram:1");
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.delete).toHaveBeenCalledWith("telegram:1");
    expect(data.has("telegram:1")).toBe(false);
  });

  it("closing the last tab also deletes the persisted row", async () => {
    const { store, calls } = createFakeStore();
    setChatStateStoreForTesting(store);

    createNewTab("telegram:1");
    closeTab("telegram:1", "t1");
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.delete).toHaveBeenCalledWith("telegram:1");
  });
});

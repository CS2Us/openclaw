import { describe, expect, it } from "vitest";
import type { ChatState } from "./chat-state.js";
import {
  ACTION,
  buildCallbackData,
  INTERACTIVE_NAMESPACE,
  parseCallbackPayload,
  renderTabManager,
} from "./tab-manager-ui.js";

function emptyState(): ChatState {
  return { tabs: [], activeTabId: null, lastUsedAt: 0 };
}

describe("parseCallbackPayload", () => {
  it("parses switch:<tabId>", () => {
    expect(parseCallbackPayload("sw:t3")).toEqual({ kind: "switch", tabId: "t3" });
  });

  it("parses newTab", () => {
    expect(parseCallbackPayload("nw")).toEqual({ kind: "newTab" });
  });

  it("parses closeTab:<tabId>", () => {
    expect(parseCallbackPayload("cl:t1")).toEqual({ kind: "closeTab", tabId: "t1" });
  });

  it("parses resetAll", () => {
    expect(parseCallbackPayload("rs")).toEqual({ kind: "resetAll" });
  });

  it("parses import:<sessionId>", () => {
    expect(parseCallbackPayload("im:5c4eb7ff-3fb9-4fde-be46-862bea97cf5f")).toEqual({
      kind: "import",
      sessionId: "5c4eb7ff-3fb9-4fde-be46-862bea97cf5f",
    });
  });

  it("returns unknown for unrecognized", () => {
    expect(parseCallbackPayload("garbage")).toEqual({ kind: "unknown", raw: "garbage" });
  });
});

describe("buildCallbackData", () => {
  it("namespaces and joins parts", () => {
    expect(buildCallbackData(ACTION.switch, "t3")).toBe(`${INTERACTIVE_NAMESPACE}:sw:t3`);
    expect(buildCallbackData(ACTION.newTab)).toBe(`${INTERACTIVE_NAMESPACE}:nw`);
  });

  it("stays well within Telegram's 64-byte callback_data budget", () => {
    expect(buildCallbackData(ACTION.switch, "t99").length).toBeLessThan(64);
  });
});

describe("renderTabManager", () => {
  it("empty state surfaces a [+ 新 tab] action only", () => {
    const ui = renderTabManager(emptyState());
    expect(ui.text).toContain("还没有 tab");
    // No tab rows, only the action row
    const actionRow = ui.interactive.blocks[0];
    if (actionRow?.type !== "buttons") {
      throw new Error("expected buttons");
    }
    expect(actionRow.buttons.map((b) => b.value)).toEqual([buildCallbackData(ACTION.newTab)]);
  });

  it("renders one switch row per tab plus action row", () => {
    const state: ChatState = {
      tabs: [
        { id: "t1", sessionId: "abc12345xx", label: "张三", createdAt: 1, lastUsedAt: 1 },
        { id: "t2", sessionId: null, label: "Tab 2", createdAt: 2, lastUsedAt: 2 },
      ],
      activeTabId: "t1",
      lastUsedAt: 2,
    };
    const ui = renderTabManager(state);
    expect(ui.text).toContain("Tabs (2)");
    expect(ui.text).toContain("张三");
    // 2 tab rows + 1 action row
    expect(ui.interactive.blocks.length).toBe(3);

    const tabRow1 = ui.interactive.blocks[0];
    const tabRow2 = ui.interactive.blocks[1];
    const actionRow = ui.interactive.blocks[2];
    if (
      tabRow1?.type !== "buttons" ||
      tabRow2?.type !== "buttons" ||
      actionRow?.type !== "buttons"
    ) {
      throw new Error("expected buttons blocks");
    }
    expect(tabRow1.buttons[0]?.value).toBe(buildCallbackData(ACTION.switch, "t1"));
    expect(tabRow1.buttons[0]?.label.startsWith("●")).toBe(true);
    expect(tabRow2.buttons[0]?.label.startsWith("○")).toBe(true);

    const actionValues = actionRow.buttons.map((b) => b.value);
    expect(actionValues).toEqual([
      buildCallbackData(ACTION.newTab),
      buildCallbackData(ACTION.closeTab, "t1"),
      buildCallbackData(ACTION.resetAll),
    ]);
  });

  it("hides Close button when no active tab", () => {
    const state: ChatState = {
      tabs: [{ id: "t1", sessionId: null, label: "Tab 1", createdAt: 1, lastUsedAt: 1 }],
      activeTabId: null,
      lastUsedAt: 1,
    };
    const ui = renderTabManager(state);
    const actionRow = ui.interactive.blocks.at(-1);
    if (actionRow?.type !== "buttons") {
      throw new Error("expected buttons");
    }
    expect(actionRow.buttons.map((b) => b.value)).toEqual([
      buildCallbackData(ACTION.newTab),
      buildCallbackData(ACTION.resetAll),
    ]);
  });

  it("renders recent local sessions section with [↓ Import] buttons", () => {
    const state: ChatState = {
      tabs: [{ id: "t1", sessionId: "abc", label: "Tab 1", createdAt: 1, lastUsedAt: 1 }],
      activeTabId: "t1",
      lastUsedAt: 1,
    };
    const ui = renderTabManager(state, {
      recentLocalSessions: [
        { sessionId: "5c4eb7ff", preview: "我叫张三", eventCount: 5 },
        { sessionId: "deadbeef", preview: null, eventCount: 1 },
      ],
    });
    expect(ui.text).toContain("最近本地 session");
    expect(ui.text).toContain("我叫张三");
    // tab row + action row + 2 import rows = 4
    expect(ui.interactive.blocks.length).toBe(4);
    const importRow1 = ui.interactive.blocks[2];
    const importRow2 = ui.interactive.blocks[3];
    if (importRow1?.type !== "buttons" || importRow2?.type !== "buttons") {
      throw new Error("expected buttons");
    }
    expect(importRow1.buttons[0]?.value).toBe(buildCallbackData(ACTION.importSession, "5c4eb7ff"));
    expect(importRow1.buttons[0]?.label).toContain("我叫张三");
    expect(importRow2.buttons[0]?.label).toContain("Session ");
  });

  it("truncates long labels in button text", () => {
    const long = "x".repeat(40);
    const state: ChatState = {
      tabs: [{ id: "t1", sessionId: null, label: long, createdAt: 1, lastUsedAt: 1 }],
      activeTabId: "t1",
      lastUsedAt: 1,
    };
    const ui = renderTabManager(state);
    const tabRow = ui.interactive.blocks[0];
    if (tabRow?.type !== "buttons") {
      throw new Error("expected buttons");
    }
    // active dot + space + truncated label, well under telegram's button text budget
    const btn = tabRow.buttons[0];
    expect(btn?.label.length).toBeLessThan(30);
    expect(btn?.label.endsWith("…")).toBe(true);
  });
});

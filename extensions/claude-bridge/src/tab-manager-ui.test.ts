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

  // closeTab / resetAll / import are no longer rendered as buttons but the
  // parser still recognizes them so stale callback_data from older messages
  // in chat history still routes to a meaningful handler.
  it("still parses closeTab:<tabId> for stale buttons", () => {
    expect(parseCallbackPayload("cl:t1")).toEqual({ kind: "closeTab", tabId: "t1" });
  });

  it("still parses resetAll for stale buttons", () => {
    expect(parseCallbackPayload("rs")).toEqual({ kind: "resetAll" });
  });

  it("still parses import:<sessionId> for stale buttons", () => {
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
  it("empty state shows hint text + only the [+ 新 session] row", () => {
    const ui = renderTabManager(emptyState());
    expect(ui.text).toContain("还没有会话");
    // No tab-code rows, just the new-session row.
    expect(ui.interactive.blocks.length).toBe(1);
    const topRow = ui.interactive.blocks[0];
    if (topRow?.type !== "buttons") {
      throw new Error("expected buttons");
    }
    expect(topRow.buttons.map((b) => b.value)).toEqual([buildCallbackData(ACTION.newTab)]);
  });

  it("renders [+ 新 session] then a packed numbered switch row — and nothing else", () => {
    const state: ChatState = {
      tabs: [
        { id: "t1", sessionId: "abc12345xx", label: "我叫张三", createdAt: 1, lastUsedAt: 1 },
        { id: "t2", sessionId: null, label: "下一个会话", createdAt: 2, lastUsedAt: 2 },
      ],
      activeTabId: "t1",
      lastUsedAt: 2,
    };
    const ui = renderTabManager(state);

    // Text: numbered titles only, no `Tabs (N)：` header, no `— sid` suffix.
    expect(ui.text).toMatch(/●1\.\s+\*\*我叫张三\*\*/);
    expect(ui.text).toMatch(/2\.\s+\*\*下一个会话\*\*/);
    expect(ui.text).not.toContain("—"); // no sid suffix
    expect(ui.text).not.toContain("Tabs ("); // no header

    // Buttons: [+ 新 session] row + one packed tab-code row. No danger row,
    // no import row.
    expect(ui.interactive.blocks.length).toBe(2);

    const topRow = ui.interactive.blocks[0];
    const tabRow = ui.interactive.blocks[1];
    if (topRow?.type !== "buttons" || tabRow?.type !== "buttons") {
      throw new Error("expected buttons blocks");
    }
    expect(topRow.buttons.map((b) => b.value)).toEqual([buildCallbackData(ACTION.newTab)]);
    expect(tabRow.buttons.map((b) => b.label)).toEqual(["●1", "2"]);
    expect(tabRow.buttons.map((b) => b.value)).toEqual([
      buildCallbackData(ACTION.switch, "t1"),
      buildCallbackData(ACTION.switch, "t2"),
    ]);
  });

  it("no active tab → tab-code button has no dot prefix", () => {
    const state: ChatState = {
      tabs: [{ id: "t1", sessionId: null, label: "Tab 1", createdAt: 1, lastUsedAt: 1 }],
      activeTabId: null,
      lastUsedAt: 1,
    };
    const ui = renderTabManager(state);
    expect(ui.interactive.blocks.length).toBe(2); // top + tab row
    const tabRow = ui.interactive.blocks[1];
    if (tabRow?.type !== "buttons") {
      throw new Error("expected buttons");
    }
    expect(tabRow.buttons[0]?.label).toBe("1");
  });

  it("packs more than TABS_PER_ROW tabs across multiple rows", () => {
    const tabs: ChatState["tabs"] = [];
    for (let i = 1; i <= 8; i++) {
      tabs.push({ id: `t${i}`, sessionId: null, label: `Tab ${i}`, createdAt: i, lastUsedAt: i });
    }
    const state: ChatState = { tabs, activeTabId: "t1", lastUsedAt: 8 };
    const ui = renderTabManager(state);
    // top row + tab-row1(6) + tab-row2(2) — no danger or import rows.
    expect(ui.interactive.blocks.length).toBe(3);
    const tabRow1 = ui.interactive.blocks[1];
    const tabRow2 = ui.interactive.blocks[2];
    if (tabRow1?.type !== "buttons" || tabRow2?.type !== "buttons") {
      throw new Error("expected buttons");
    }
    expect(tabRow1.buttons.map((b) => b.label)).toEqual(["●1", "2", "3", "4", "5", "6"]);
    expect(tabRow2.buttons.map((b) => b.label)).toEqual(["7", "8"]);
  });

  it("long titles stay in text section; tab-code buttons stay one-or-two chars", () => {
    const long = "x".repeat(40);
    const state: ChatState = {
      tabs: [{ id: "t1", sessionId: null, label: long, createdAt: 1, lastUsedAt: 1 }],
      activeTabId: "t1",
      lastUsedAt: 1,
    };
    const ui = renderTabManager(state);
    const tabRow = ui.interactive.blocks[1];
    if (tabRow?.type !== "buttons") {
      throw new Error("expected buttons");
    }
    expect(tabRow.buttons[0]?.label).toBe("●1");
    expect(ui.text).toContain(long);
  });
});

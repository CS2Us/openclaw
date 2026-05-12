import { describe, expect, it } from "vitest";
import {
  ACTION,
  buildCallbackData,
  INTERACTIVE_NAMESPACE,
  type PanelEntry,
  parseCallbackPayload,
  renderPanel,
} from "./tab-manager-ui.js";

describe("parseCallbackPayload", () => {
  it("parses switch:<sessionId>", () => {
    expect(parseCallbackPayload("sw:abc12345-1111-2222-3333-444455556666")).toEqual({
      kind: "switch",
      sessionId: "abc12345-1111-2222-3333-444455556666",
    });
  });

  it("parses newTab / refresh / follow / unfollow", () => {
    expect(parseCallbackPayload("nw")).toEqual({ kind: "newTab" });
    expect(parseCallbackPayload("rf")).toEqual({ kind: "refresh" });
    expect(parseCallbackPayload("fo")).toEqual({ kind: "follow" });
    expect(parseCallbackPayload("uf")).toEqual({ kind: "unfollow" });
  });

  it("parses enterAndFollow:<sessionId> — used by approval-companion buttons", () => {
    expect(parseCallbackPayload("ef:abc12345-1111-2222-3333-444455556666")).toEqual({
      kind: "enterAndFollow",
      sessionId: "abc12345-1111-2222-3333-444455556666",
    });
  });

  it("parses approveDecision:<approvalId>:<shortcode> — own approval card", () => {
    expect(parseCallbackPayload("ad:abc12345-1111-2222-3333-444455556666:a1")).toEqual({
      kind: "approveDecision",
      approvalId: "abc12345-1111-2222-3333-444455556666",
      decision: "allow-once",
    });
    expect(parseCallbackPayload("ad:xyz:aa")).toEqual({
      kind: "approveDecision",
      approvalId: "xyz",
      decision: "allow-always",
    });
    expect(parseCallbackPayload("ad:xyz:dn")).toEqual({
      kind: "approveDecision",
      approvalId: "xyz",
      decision: "deny",
    });
  });

  it("rejects approveDecision with unknown shortcode / missing parts", () => {
    expect(parseCallbackPayload("ad:xyz:xx")).toEqual({ kind: "unknown", raw: "ad:xyz:xx" });
    expect(parseCallbackPayload("ad:xyz")).toEqual({ kind: "unknown", raw: "ad:xyz" });
    expect(parseCallbackPayload("ad")).toEqual({ kind: "unknown", raw: "ad" });
  });

  // closeTab / resetAll / import are no longer rendered as buttons but the
  // parser still recognizes them so stale callback_data from older messages
  // in chat history still routes to a meaningful handler.
  it("still parses legacy closeTab / resetAll / import for stale buttons", () => {
    expect(parseCallbackPayload("cl:t1")).toEqual({ kind: "closeTab", tabId: "t1" });
    expect(parseCallbackPayload("rs")).toEqual({ kind: "resetAll" });
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
    expect(buildCallbackData(ACTION.switch, "sid")).toBe(`${INTERACTIVE_NAMESPACE}:sw:sid`);
    expect(buildCallbackData(ACTION.newTab)).toBe(`${INTERACTIVE_NAMESPACE}:nw`);
    expect(buildCallbackData(ACTION.enterAndFollow, "sid")).toBe(`${INTERACTIVE_NAMESPACE}:ef:sid`);
  });

  it("stays well within Telegram's 64-byte callback_data budget for full UUIDs", () => {
    const uuid = "abc12345-1111-2222-3333-444455556666";
    expect(buildCallbackData(ACTION.switch, uuid).length).toBeLessThan(64);
    expect(buildCallbackData(ACTION.enterAndFollow, uuid).length).toBeLessThan(64);
  });
});

function entry(partial: Partial<PanelEntry> & { sessionId: string }): PanelEntry {
  return {
    preview: "hello",
    lastActivityMs: Date.now(),
    ...partial,
  };
}

describe("renderPanel", () => {
  it("empty entries → hint text + only the [+ 新 session] row", () => {
    const ui = renderPanel({ entries: [], activeSessionId: null });
    expect(ui.text).toContain("还没有 claude session");
    expect(ui.interactive.blocks.length).toBe(1);
    const topRow = ui.interactive.blocks[0];
    if (topRow?.type !== "buttons") throw new Error("expected buttons");
    expect(topRow.buttons.map((b) => b.value)).toEqual([buildCallbackData(ACTION.newTab)]);
  });

  it("entries with no active → top row + numeric switch row, no follow button", () => {
    const ui = renderPanel({
      entries: [entry({ sessionId: "s1" }), entry({ sessionId: "s2" })],
      activeSessionId: null,
    });
    expect(ui.interactive.blocks.length).toBe(2);
    const topRow = ui.interactive.blocks[0];
    const switchRow = ui.interactive.blocks[1];
    if (topRow?.type !== "buttons" || switchRow?.type !== "buttons") {
      throw new Error("expected buttons");
    }
    // No follow button when no active session is selected.
    expect(topRow.buttons.map((b) => b.value)).toEqual([buildCallbackData(ACTION.newTab)]);
    expect(switchRow.buttons.map((b) => b.label)).toEqual(["1", "2"]);
    expect(switchRow.buttons.map((b) => b.value)).toEqual([
      buildCallbackData(ACTION.switch, "s1"),
      buildCallbackData(ACTION.switch, "s2"),
    ]);
  });

  it("active session → top row gets [👁 实时流] button alongside [+ 新 session]", () => {
    const ui = renderPanel({
      entries: [entry({ sessionId: "s1" })],
      activeSessionId: "s1",
    });
    const topRow = ui.interactive.blocks[0];
    if (topRow?.type !== "buttons") throw new Error("expected buttons");
    expect(topRow.buttons.map((b) => b.value)).toEqual([
      buildCallbackData(ACTION.newTab),
      buildCallbackData(ACTION.follow),
    ]);
  });

  it("followActive → top row replaces 实时流 with [⏹ 停止流]", () => {
    const ui = renderPanel({
      entries: [entry({ sessionId: "s1" })],
      activeSessionId: "s1",
      followActive: true,
    });
    const topRow = ui.interactive.blocks[0];
    if (topRow?.type !== "buttons") throw new Error("expected buttons");
    expect(topRow.buttons.map((b) => b.value)).toEqual([
      buildCallbackData(ACTION.newTab),
      buildCallbackData(ACTION.unfollow),
    ]);
  });

  it("active session is split out as 📌 header; switch row shows only OTHERS", () => {
    const ui = renderPanel({
      entries: [
        entry({ sessionId: "s1", preview: "active prompt" }),
        entry({ sessionId: "s2", preview: "other prompt" }),
      ],
      activeSessionId: "s1",
    });
    // Header line shows the active session.
    expect(ui.text).toContain("📌 当前:");
    expect(ui.text).toContain("active prompt");
    // Switch row only contains buttons for OTHER sessions, plain numbers, no
    // ● marker.
    const switchRow = ui.interactive.blocks[1];
    if (switchRow?.type !== "buttons") throw new Error("expected buttons");
    expect(switchRow.buttons.map((b) => b.label)).toEqual(["1"]);
    expect(switchRow.buttons.map((b) => b.value)).toEqual([buildCallbackData(ACTION.switch, "s2")]);
  });

  it("renders 'no other session' note when active is the only one in pool", () => {
    const ui = renderPanel({
      entries: [entry({ sessionId: "only" })],
      activeSessionId: "only",
    });
    expect(ui.text).toContain("📌 当前:");
    expect(ui.text).toContain("没有其他可切的 session");
    // Top row only — no switch row when there are no others.
    expect(ui.interactive.blocks.length).toBe(1);
  });

  it("shows active-as-header even when the session is not in pool entries", () => {
    const ui = renderPanel({
      entries: [entry({ sessionId: "s2" })],
      activeSessionId: "fresh-session-not-in-pool",
    });
    expect(ui.text).toContain("📌 当前:");
    expect(ui.text).toContain("(新会话 · 待首条消息)");
    const switchRow = ui.interactive.blocks[1];
    if (switchRow?.type !== "buttons") throw new Error("expected buttons");
    expect(switchRow.buttons.map((b) => b.label)).toEqual(["1"]);
  });

  it("caps at 3 entries (MAX_PANEL_ENTRIES)", () => {
    const ui = renderPanel({
      entries: [
        entry({ sessionId: "s1" }),
        entry({ sessionId: "s2" }),
        entry({ sessionId: "s3" }),
        entry({ sessionId: "s4" }),
      ],
      activeSessionId: null,
    });
    const switchRow = ui.interactive.blocks[1];
    if (switchRow?.type !== "buttons") throw new Error("expected buttons");
    expect(switchRow.buttons.length).toBe(3);
  });

  it("each line shows sid-8-char prefix before the preview", () => {
    const ui = renderPanel({
      entries: [
        entry({
          sessionId: "abc12345-1111-2222-3333-444455556666",
          preview: "test prompt",
        }),
      ],
      activeSessionId: null,
    });
    expect(ui.text).toContain("`abc12345`");
    expect(ui.text).toContain("test prompt");
  });

  it("optional header is rendered above the listing", () => {
    const ui = renderPanel({
      entries: [entry({ sessionId: "s1" })],
      activeSessionId: "s1",
      header: "📍 切到 session test",
    });
    expect(ui.text.startsWith("📍 切到 session test")).toBe(true);
  });
});

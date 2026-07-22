import { describe, expect, it } from "vitest";
import { chunkForTelegram, formatJsonlEvent, pickBackfillEvents } from "./follow.js";

const userLine = (text: string) =>
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text }] } });
const assistantLine = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const toolUseLine = (name: string) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input: {} }] },
  });

describe("formatJsonlEvent", () => {
  it("tags user events with kind=user", () => {
    const ev = formatJsonlEvent(userLine("hi"));
    expect(ev?.kind).toBe("user");
    expect(ev?.text).toContain("hi");
  });

  it("tags assistant text events with kind=assistant", () => {
    const ev = formatJsonlEvent(assistantLine("hello"));
    expect(ev?.kind).toBe("assistant");
    expect(ev?.text).toContain("hello");
  });

  it("tags tool_use-only assistant events with kind=assistant + hasToolUse", () => {
    const ev = formatJsonlEvent(toolUseLine("Bash"));
    expect(ev?.kind).toBe("assistant");
    expect(ev?.hasToolUse).toBe(true);
    expect(ev?.text).toBeNull();
  });

  it("returns null for meta / toolUseResult / system / unparseable", () => {
    expect(
      formatJsonlEvent(JSON.stringify({ type: "user", isMeta: true, message: { content: "x" } })),
    ).toBeNull();
    expect(
      formatJsonlEvent(
        JSON.stringify({ type: "user", toolUseResult: {}, message: { content: "x" } }),
      ),
    ).toBeNull();
    expect(formatJsonlEvent(JSON.stringify({ type: "system", session_id: "s" }))).toBeNull();
    expect(formatJsonlEvent("not json")).toBeNull();
  });
});

describe("pickBackfillEvents", () => {
  it("returns last N user events plus everything after", () => {
    const lines = [
      userLine("q1"),
      assistantLine("a1"),
      userLine("q2"),
      assistantLine("a2"),
      userLine("q3"),
      assistantLine("a3"),
      userLine("q4"),
      assistantLine("a4"),
    ];
    const tail = pickBackfillEvents(lines, 2);
    // Should start at q3 (3rd user) and include a3, q4, a4.
    expect(tail).toEqual(lines.slice(4));
  });

  it("returns from first user event when total users <= N", () => {
    const lines = [userLine("q1"), assistantLine("a1"), userLine("q2")];
    expect(pickBackfillEvents(lines, 5)).toEqual(lines);
  });

  it("returns empty when there are no user events", () => {
    expect(pickBackfillEvents([assistantLine("only")], 3)).toEqual([]);
  });

  it("returns empty when n<=0", () => {
    expect(pickBackfillEvents([userLine("q")], 0)).toEqual([]);
    expect(pickBackfillEvents([userLine("q")], -1)).toEqual([]);
  });

  it("skips meta/toolUseResult user events when counting anchors", () => {
    // Two `type:user` lines but one is meta → only one surfaced user event.
    const meta = JSON.stringify({
      type: "user",
      isMeta: true,
      message: { content: [{ type: "text", text: "ignored" }] },
    });
    const lines = [meta, assistantLine("a0"), userLine("real"), assistantLine("a1")];
    // N=1 → anchor on the real user line, include its assistant follow-up.
    expect(pickBackfillEvents(lines, 1)).toEqual(lines.slice(2));
  });
});

describe("chunkForTelegram", () => {
  it("returns the input untouched when below the cap", () => {
    expect(chunkForTelegram("👤 你：\nshort", 100)).toEqual(["👤 你：\nshort"]);
  });

  it("splits long body into (i/N) chunks, preserving the prefix", () => {
    // Body of 250 chars, cap of 100 → labelOverhead reserves ~24, bodyMax≈76.
    // With no newlines/spaces it falls back to a hard cut.
    const body = "x".repeat(250);
    const chunks = chunkForTelegram(`🤖 claude：\n${body}`, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toMatch(/^🤖 claude \(1\/\d+\)：\n/);
    expect(chunks.at(-1)).toMatch(/^🤖 claude \(\d+\/\d+\)：\n/);
    // Reassembling the bodies recovers the original.
    const recovered = chunks.map((c) => c.slice(c.indexOf("\n") + 1)).join("");
    expect(recovered).toBe(body);
  });

  it("prefers newline boundaries when splitting body", () => {
    // Body must exceed the 200-char floor for splitBody to kick in.
    const head = "a".repeat(180);
    const tail = "b".repeat(180);
    const body = `${head}\n${tail}`;
    const chunks = chunkForTelegram(`👤 你：\n${body}`, 240);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(`👤 你 (1/2)：\n${head}`);
    expect(chunks[1]).toBe(`👤 你 (2/2)：\n${tail}`);
  });

  it("hard-splits a prefix-less message that overflows", () => {
    const text = "y".repeat(50);
    expect(chunkForTelegram(text, 20)).toEqual(["y".repeat(20), "y".repeat(20), "y".repeat(10)]);
  });
});

describe("formatJsonlEvent text length", () => {
  it("no longer truncates long bodies (chunker handles size at send time)", () => {
    const longUser = "p".repeat(8000);
    const ev = formatJsonlEvent(userLine(longUser));
    expect(ev?.text).toContain(longUser);
    expect(ev?.text).not.toContain("…");
  });
});

import { describe, expect, it } from "vitest";
import { createStreamJsonAggregator, truncate } from "./handler.js";

describe("createStreamJsonAggregator", () => {
  it("captures session_id from the first system event", () => {
    const agg = createStreamJsonAggregator();
    agg.feedLine(JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123" }));
    expect(agg.finalize().sessionId).toBe("abc-123");
  });

  it("ignores subsequent system session_id once captured", () => {
    const agg = createStreamJsonAggregator();
    agg.feedLine(JSON.stringify({ type: "system", session_id: "first" }));
    agg.feedLine(JSON.stringify({ type: "system", session_id: "second" }));
    expect(agg.finalize().sessionId).toBe("first");
  });

  it("accumulates text content from assistant blocks in order", () => {
    const agg = createStreamJsonAggregator();
    agg.feedLine(JSON.stringify({ type: "system", session_id: "s" }));
    agg.feedLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello, " }] },
      }),
    );
    agg.feedLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "world" },
            { type: "text", text: "!" },
          ],
        },
      }),
    );
    expect(agg.finalize().text).toBe("Hello, world!");
  });

  it("skips non-text content blocks (tool_use, thinking, etc.)", () => {
    const agg = createStreamJsonAggregator();
    agg.feedLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "internal" },
            { type: "text", text: "visible" },
            { type: "tool_use", name: "Read", input: { path: "/etc/passwd" } },
          ],
        },
      }),
    );
    expect(agg.finalize().text).toBe("visible");
  });

  it("ignores unrelated event types (result, user tool_result echoes)", () => {
    const agg = createStreamJsonAggregator();
    agg.feedLine(
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", content: "ok" }] },
      }),
    );
    agg.feedLine(JSON.stringify({ type: "result", subtype: "success", duration_ms: 42 }));
    expect(agg.finalize().text).toBe("");
    expect(agg.finalize().sessionId).toBeNull();
  });

  it("survives malformed JSON lines (drop and continue)", () => {
    const agg = createStreamJsonAggregator();
    agg.feedLine("not json at all");
    agg.feedLine("");
    agg.feedLine(JSON.stringify({ type: "system", session_id: "after-noise" }));
    agg.feedLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      }),
    );
    expect(agg.finalize().sessionId).toBe("after-noise");
    expect(agg.finalize().text).toBe("ok");
  });

  it("ignores assistant events without a content array", () => {
    const agg = createStreamJsonAggregator();
    agg.feedLine(JSON.stringify({ type: "assistant", message: {} }));
    agg.feedLine(JSON.stringify({ type: "assistant", message: { content: "nope" } }));
    expect(agg.finalize().text).toBe("");
  });
});

describe("truncate", () => {
  it("returns text unchanged when within the limit", () => {
    expect(truncate("hi", 10)).toBe("hi");
  });

  it("appends a suffix indicating dropped chars when over the limit", () => {
    expect(truncate("abcdef", 3)).toBe("abc\n\n…(truncated, 3 chars dropped)");
  });
});

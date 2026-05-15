import { describe, expect, it } from "vitest";
import { applyEvent, finalizeReply, newAccumulator, truncate } from "./format.js";

describe("format accumulator", () => {
  it("aggregates text_delta into final reply", () => {
    const acc = newAccumulator();
    applyEvent(acc, { type: "turn_started", turn_id: "t" });
    applyEvent(acc, { type: "text_delta", turn_id: "t", delta: "Hello, " });
    applyEvent(acc, { type: "text_delta", turn_id: "t", delta: "world!" });
    applyEvent(acc, {
      type: "turn_completed",
      turn_id: "t",
      iterations: 1,
      hit_max_turns: false,
    });
    expect(finalizeReply(acc, 1000)).toBe("Hello, world!");
  });

  it("renders tool_call + tool_result as folded lines above text", () => {
    const acc = newAccumulator();
    applyEvent(acc, {
      type: "tool_call",
      turn_id: "t",
      tool: "commerce_create_order",
      input: {},
    });
    applyEvent(acc, {
      type: "tool_result",
      turn_id: "t",
      tool: "commerce_create_order",
      output: {},
    });
    applyEvent(acc, { type: "text_delta", turn_id: "t", delta: "订单已创建" });
    applyEvent(acc, {
      type: "turn_completed",
      turn_id: "t",
      iterations: 2,
      hit_max_turns: false,
    });
    const reply = finalizeReply(acc, 1000);
    expect(reply).toContain("⚙️ 调用 `commerce_create_order`");
    expect(reply).toContain("✓ `commerce_create_order` 完成");
    expect(reply).toContain("订单已创建");
  });

  it("surfaces error event with warning prefix", () => {
    const acc = newAccumulator();
    applyEvent(acc, { type: "error", message: "model timeout" });
    const reply = finalizeReply(acc, 1000);
    expect(reply).toContain("⚠️ 出错");
    expect(reply).toContain("model timeout");
  });

  it("marks aborted turns", () => {
    const acc = newAccumulator();
    applyEvent(acc, { type: "text_delta", turn_id: "t", delta: "partial" });
    applyEvent(acc, { type: "aborted", turn_id: "t" });
    const reply = finalizeReply(acc, 1000);
    expect(reply).toContain("partial");
    expect(reply).toContain("(已中断)");
  });

  it("marks hit_max_turns when completed flag set", () => {
    const acc = newAccumulator();
    applyEvent(acc, { type: "text_delta", turn_id: "t", delta: "...overflow" });
    applyEvent(acc, {
      type: "turn_completed",
      turn_id: "t",
      iterations: 50,
      hit_max_turns: true,
    });
    const reply = finalizeReply(acc, 1000);
    expect(reply).toContain("...overflow");
    expect(reply).toContain("(达到最大轮次)");
  });

  it("hides reactive_* diagnostic metadata events from reply", () => {
    const acc = newAccumulator();
    applyEvent(acc, {
      type: "metadata",
      turn_id: "t",
      source: "reactive_compact",
      data: { turns_removed: 5 },
    });
    applyEvent(acc, {
      type: "metadata",
      turn_id: "t",
      source: "reactive_media_strip",
      data: { stripped: 2 },
    });
    applyEvent(acc, { type: "text_delta", turn_id: "t", delta: "ok" });
    applyEvent(acc, {
      type: "turn_completed",
      turn_id: "t",
      iterations: 1,
      hit_max_turns: false,
    });
    expect(finalizeReply(acc, 1000)).toBe("ok");
  });

  it("renders model_response usage as token summary line", () => {
    const acc = newAccumulator();
    applyEvent(acc, {
      type: "metadata",
      turn_id: "t1",
      source: "model_response",
      data: {
        usage: {
          input_tokens: 520,
          output_tokens: 180,
          cache_read_tokens: 8200,
          cache_creation_tokens: 0,
        },
      },
    });
    applyEvent(acc, { type: "text_delta", turn_id: "t1", delta: "好的" });
    applyEvent(acc, {
      type: "turn_completed",
      turn_id: "t1",
      iterations: 1,
      hit_max_turns: false,
    });
    const reply = finalizeReply(acc, 1000);
    expect(reply).toContain("好的");
    expect(reply).toContain("📊 token: in=520 out=180 cache_read=8200 (1 turn)");
  });

  it("sums usage across multiple turns and omits zero cache fields", () => {
    const acc = newAccumulator();
    applyEvent(acc, {
      type: "metadata",
      turn_id: "t1",
      source: "model_response",
      data: { usage: { input_tokens: 100, output_tokens: 50 } },
    });
    applyEvent(acc, {
      type: "metadata",
      turn_id: "t2",
      source: "model_response",
      data: { usage: { input_tokens: 200, output_tokens: 80 } },
    });
    applyEvent(acc, { type: "text_delta", turn_id: "t2", delta: "done" });
    applyEvent(acc, {
      type: "turn_completed",
      turn_id: "t2",
      iterations: 2,
      hit_max_turns: false,
    });
    const reply = finalizeReply(acc, 1000);
    expect(reply).toContain("📊 token: in=300 out=130 (2 turns)");
    expect(reply).not.toContain("cache_read");
    expect(reply).not.toContain("cache_creation");
  });

  it("omits token line when no model_response metadata seen", () => {
    const acc = newAccumulator();
    applyEvent(acc, { type: "text_delta", turn_id: "t", delta: "hello" });
    applyEvent(acc, {
      type: "turn_completed",
      turn_id: "t",
      iterations: 1,
      hit_max_turns: false,
    });
    expect(finalizeReply(acc, 1000)).toBe("hello");
  });

  it("truncates over-long bodies preserving ellipsis", () => {
    expect(truncate("x".repeat(20), 10)).toBe("xxxxxxx...");
    expect(truncate("short", 100)).toBe("short");
  });
});

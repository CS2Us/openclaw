// Format chromite SSE events into a single Telegram reply text.
// sub-spec chromite-harness-openclaw-bridge-v1 §1 + §3 决策 #F.
//
// v1 collect-then-reply：累积 text_delta；tool_call / tool_result 折叠为
// 简短行 ("⚙️ 调用 `tool_name`..." → "✓ `tool_name` 完成")。turn_completed
// 触发 finalize；error 单独标记。

import type { ChromiteEvent } from "./chromite-client.js";

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turns: number;
};

export type Accumulator = {
  textParts: string[];
  toolLines: string[];
  errorMessage: string | null;
  aborted: boolean;
  hitMaxTurns: boolean;
  completed: boolean;
  usage: UsageTotals;
};

export function newAccumulator(): Accumulator {
  return {
    textParts: [],
    toolLines: [],
    errorMessage: null,
    aborted: false,
    hitMaxTurns: false,
    completed: false,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      turns: 0,
    },
  };
}

export function applyEvent(acc: Accumulator, ev: ChromiteEvent): void {
  switch (ev.type) {
    case "turn_started":
      // no-op；用户已收到 ack 消息
      return;
    case "text_delta":
      acc.textParts.push(ev.delta);
      return;
    case "tool_call":
      acc.toolLines.push(`⚙️ 调用 \`${ev.tool}\`…`);
      return;
    case "tool_result":
      acc.toolLines.push(`✓ \`${ev.tool}\` 完成`);
      return;
    case "metadata":
      // source = "model_response" 含 anthropic usage; 其它（reactive_compact /
      // reactive_media_strip）是内部诊断，silently drop。
      if (ev.source === "model_response") {
        accumulateUsage(acc.usage, ev.data);
      }
      return;
    case "turn_completed":
      acc.completed = true;
      acc.hitMaxTurns = ev.hit_max_turns;
      return;
    case "aborted":
      acc.aborted = true;
      return;
    case "error":
      acc.errorMessage = ev.message;
      return;
  }
}

/**
 * Build the final Telegram reply text from accumulated events.
 * Truncate body if exceeds maxChars (Telegram 4096-char hard limit minus margin).
 */
export function finalizeReply(acc: Accumulator, maxChars: number): string {
  const parts: string[] = [];

  if (acc.toolLines.length > 0) {
    parts.push(acc.toolLines.join("\n"));
  }

  const text = acc.textParts.join("").trim();
  if (text) {
    parts.push(text);
  }

  if (acc.errorMessage) {
    parts.push(`⚠️ 出错：${acc.errorMessage}`);
  } else if (acc.aborted) {
    parts.push("(已中断)");
  } else if (acc.hitMaxTurns) {
    parts.push("(达到最大轮次)");
  } else if (!acc.completed && parts.length === 0) {
    parts.push("(无输出)");
  }

  const usageLine = formatUsage(acc.usage);
  if (usageLine) {
    parts.push(usageLine);
  }

  const body = parts.join("\n\n").trim();
  return truncate(body || "(无输出)", maxChars);
}

function accumulateUsage(totals: UsageTotals, data: unknown): void {
  if (!data || typeof data !== "object") return;
  const usage = (data as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return;
  const obj = usage as Record<string, unknown>;
  totals.inputTokens += toNonNegInt(obj.input_tokens);
  totals.outputTokens += toNonNegInt(obj.output_tokens);
  totals.cacheReadTokens += toNonNegInt(obj.cache_read_tokens);
  totals.cacheCreationTokens += toNonNegInt(obj.cache_creation_tokens);
  totals.turns += 1;
}

function toNonNegInt(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function formatUsage(u: UsageTotals): string | null {
  if (u.turns === 0) return null;
  const segs = [`in=${u.inputTokens}`, `out=${u.outputTokens}`];
  if (u.cacheReadTokens > 0) segs.push(`cache_read=${u.cacheReadTokens}`);
  if (u.cacheCreationTokens > 0) segs.push(`cache_creation=${u.cacheCreationTokens}`);
  const turnLabel = u.turns === 1 ? "1 turn" : `${u.turns} turns`;
  return `📊 token: ${segs.join(" ")} (${turnLabel})`;
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.max(0, maxChars - 3));
  return `${head}...`;
}

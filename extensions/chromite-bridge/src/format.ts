// Reply text helpers for chromite-bridge.
//
// hybrid-harness Part B（2026-05-30）：edge-loop 形态下 `runEdgeLoop` 直接产出最终
// 回复字符串（client 自持 Agent Loop），不再需要旧 server-loop SSE 事件累积器
// (applyEvent / finalizeReply / Accumulator)。这些随 server-side loop 一并退场。
// 本模块仅保留 Telegram 回复长度截断 helper。

/**
 * Truncate `text` to `maxChars`, preserving an ellipsis (Telegram 4096-char hard
 * limit minus margin). Reused by handler.ts for edge-loop reply truncation.
 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const head = text.slice(0, Math.max(0, maxChars - 3));
  return `${head}...`;
}

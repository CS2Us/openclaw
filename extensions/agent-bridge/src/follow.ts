// Real-time "tail -f" of a agent session jsonl, streamed to Telegram as
// formatted user/assistant messages. Each new event becomes one Telegram
// message so the user can watch a session's progress on their phone without
// being at the laptop.
//
// 设计取舍：
// - 用 setInterval 2s 轮询而非 fs.watch —— fs.watch 跨平台行为不一致，
//   小项目的可靠性比 100ms-级实时性重要
// - 走 src/telegram-bot-api.ts 的薄 fetch 封装（不经 telegram extension 的
//   outbound channel —— 那条路径绑在 request scope，背景流不适配）。封装
//   支持可选 messageThreadId 让 follow 输出落到 forum supergroup 的指定
//   topic，路由决策由 src/topic-routing.ts 在调用方做完后通过
//   FollowOptions.telegramThreadId 传入
// - daemon 由 openclaw-start.sh 注入 `NODE_OPTIONS=--use-env-proxy`，
//   所以 native fetch 自动走 https_proxy
// - 自动 30 min 上限（防忘了关）+ 每个 chat 只能 follow 一条 session
//   (registerFollow 会先 stop 旧的)
// - 只 surface 真实人类对话内容：filter isMeta / toolUseResult / 空 strip
//   后的 wrapper，跟 readSessionInfo 一致
// - 启动时 backfill 最近 N 轮 QA 作为上下文；之后的 live tail 跳过 user
//   事件（用户自己刚 DM 进来的文本不需要 echo 回去）

import fs from "node:fs";
import path from "node:path";
import { type FollowHandle, registerFollow } from "./chat-state.js";
import { sessionsDir } from "./session-discovery.js";
import { sendBotMessage, sendTypingAction } from "./telegram-bot-api.js";

const POLL_INTERVAL_MS = 2_000;
const AUTO_STOP_MS = 30 * 60 * 1000; // 30 min
const MAX_TELEGRAM_TEXT = 3_900; // <4096 with header / wrapping room
const DEFAULT_BACKFILL_QA = 3;

type FollowOptions = {
  chatKey: string;
  sessionId: string;
  cwd: string;
  telegramChatId: string;
  telegramBotToken: string;
  /**
   * Forum supergroup topic thread id. When set, all stream output (backfill,
   * live tail, typing indicator, auto-stop notice) routes into that topic;
   * `telegramChatId` should be the forum supergroup id, not the DM. When
   * omitted, output goes to `telegramChatId` directly (DM mode, legacy).
   */
  telegramThreadId?: number;
  /** Number of most recent user→assistant pairs to replay on start. Default 3. */
  backfillLastNQA?: number;
};

export function startFollow(opts: FollowOptions): FollowHandle | null {
  const jsonlPath = path.join(sessionsDir(opts.cwd), `${opts.sessionId}.jsonl`);
  let lastSize: number;
  let initialContents: string;
  try {
    lastSize = fs.statSync(jsonlPath).size;
    // Snapshot the file at startup time so backfill reads a stable prefix
    // and live tail picks up only what was appended after lastSize. Any
    // bytes claude writes between the stat and this readFile end up in
    // `initialContents` (a strict superset of the lastSize prefix is fine —
    // we trim back to lastSize bytes before parsing so the live tail still
    // catches them).
    initialContents = fs.readFileSync(jsonlPath, "utf8").slice(0, lastSize);
  } catch {
    return null;
  }

  let stopped = false;

  const backfillN = opts.backfillLastNQA ?? DEFAULT_BACKFILL_QA;
  const backfillLines = pickBackfillEvents(splitJsonlLines(initialContents), backfillN);

  // Backfill runs as the first link in the inflight chain. setInterval ticks
  // queue behind it, so even if backfill takes >2s, no tick races it. Live
  // tail reads from `lastSize` onward and never overlaps backfill's prefix.
  const inflightSeed: Promise<void> = (async () => {
    if (stopped || backfillLines.length === 0) return;
    await sendBotMessage({
      botToken: opts.telegramBotToken,
      chatId: opts.telegramChatId,
      messageThreadId: opts.telegramThreadId,
      text: `📜 最近 ${backfillN} 轮对话（回放）：`,
    });
    for (const line of backfillLines) {
      if (stopped) return;
      const parsed = formatJsonlEvent(line);
      if (!parsed) continue;
      if (parsed.text) {
        for (const chunk of chunkForTelegram(parsed.text)) {
          if (stopped) return;
          await sendBotMessage({
            botToken: opts.telegramBotToken,
            chatId: opts.telegramChatId,
            messageThreadId: opts.telegramThreadId,
            text: chunk,
          });
        }
      }
    }
  })().catch(() => {});

  let inflight: Promise<void> = inflightSeed;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(jsonlPath);
    } catch {
      return;
    }
    if (stat.size <= lastSize) return;

    let buf: Buffer;
    try {
      const fd = fs.openSync(jsonlPath, "r");
      try {
        buf = Buffer.alloc(stat.size - lastSize);
        fs.readSync(fd, buf, 0, buf.length, lastSize);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    lastSize = stat.size;

    const lines = buf
      .toString("utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    for (const line of lines) {
      if (stopped) return;
      const parsed = formatJsonlEvent(line);
      if (!parsed) continue;
      // Drop user events in live tail: the user typed them into this same
      // Telegram chat moments ago — echoing the text back is pure noise.
      // Backfill above intentionally surfaces user lines so historical
      // context still reads as a conversation.
      if (parsed.kind === "user") continue;
      // Side effect: any assistant message that contains a tool_use block
      // triggers a `typing` chat action so the user can see claude is
      // actively working without us renaming/spamming the stream with
      // [🛠 ToolName] placeholders. Telegram surfaces "typing..." in the
      // chat header for ~5s; consecutive tool_uses naturally re-extend it.
      if (parsed.hasToolUse) {
        await sendTypingAction({
          botToken: opts.telegramBotToken,
          chatId: opts.telegramChatId,
          messageThreadId: opts.telegramThreadId,
        });
      }
      if (parsed.text) {
        for (const chunk of chunkForTelegram(parsed.text)) {
          if (stopped) return;
          await sendBotMessage({
            botToken: opts.telegramBotToken,
            chatId: opts.telegramChatId,
            messageThreadId: opts.telegramThreadId,
            text: chunk,
          });
        }
      }
    }
  };

  const interval = setInterval(() => {
    inflight = inflight.then(tick).catch(() => {});
  }, POLL_INTERVAL_MS);
  interval.unref?.();

  const timeout = setTimeout(() => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    void sendBotMessage({
      botToken: opts.telegramBotToken,
      chatId: opts.telegramChatId,
      messageThreadId: opts.telegramThreadId,
      text: `⏹ follow 自动停止（30 分钟上限） · sid=\`${opts.sessionId.slice(0, 8)}\``,
    });
  }, AUTO_STOP_MS);
  timeout.unref?.();

  return {
    sessionId: opts.sessionId,
    startedAt: Date.now(),
    cleanup: () => {
      stopped = true;
      clearInterval(interval);
      clearTimeout(timeout);
    },
  };
}

/**
 * Helper: start a follow + register it in chat-state. Returns the handle or
 * null if the jsonl is missing.
 */
export function startAndRegisterFollow(opts: FollowOptions): FollowHandle | null {
  const handle = startFollow(opts);
  if (handle) {
    registerFollow(opts.chatKey, handle);
  }
  return handle;
}

export type FormattedEvent = {
  text: string | null;
  hasToolUse: boolean;
  kind: "user" | "assistant";
};

/**
 * Parse a jsonl line. Returns `null` only when the event is wholly irrelevant
 * (system/meta/tool_result). Otherwise returns `{text, hasToolUse, kind}`:
 *  - `text` is the user-facing message to send into chat (or null if the
 *    event has no conversational content — pure tool_use bursts, etc.).
 *  - `hasToolUse` is true when the assistant event contained at least one
 *    tool_use block. The caller fires a Telegram `sendChatAction(typing)`
 *    so the user can see claude is working, without us spamming the stream
 *    with `[🛠 ToolName]` placeholders (those duplicate the approval card).
 *  - `kind` lets the caller skip user events in the live tail (the user
 *    just typed them into this same Telegram chat — echoing is noise) while
 *    still surfacing them during the backfill replay.
 */
export function formatJsonlEvent(line: string): FormattedEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const type = obj["type"];

  if (type === "user") {
    if (obj["isMeta"] === true) return null;
    if ("toolUseResult" in obj) return null;
    const text = extractUserText(obj);
    const cleaned = stripWrapperTags(text).trim();
    if (!cleaned) return null;
    return {
      text: `👤 你：\n${cleaned}`,
      hasToolUse: false,
      kind: "user",
    };
  }

  if (type === "assistant") {
    const message = obj["message"];
    if (typeof message !== "object" || message === null) return null;
    const content = (message as Record<string, unknown>)["content"];
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    let hasToolUse = false;
    for (const c of content) {
      if (typeof c !== "object" || c === null) continue;
      const block = c as Record<string, unknown>;
      if (block["type"] === "text" && typeof block["text"] === "string") {
        parts.push(block["text"]);
      } else if (block["type"] === "tool_use") {
        hasToolUse = true;
      }
    }
    const text = parts.join("\n").trim();
    if (!text && !hasToolUse) return null;
    return {
      text: text ? `🤖 claude：\n${text}` : null,
      hasToolUse,
      kind: "assistant",
    };
  }

  return null;
}

function splitJsonlLines(contents: string): string[] {
  return contents.split("\n").filter((line) => line.length > 0);
}

/**
 * Pick the tail of `lines` that contains the last `n` surfaced user events
 * (`formatJsonlEvent` non-null with kind="user") plus every assistant event
 * that follows them. Pure helper — operates on raw jsonl line strings so it
 * can be unit-tested without fs.
 *
 * If there are fewer than `n` user events in the file, returns from the
 * first surfaced user event. If there are no surfaced user events, returns
 * an empty list (no anchor for the replay).
 */
export function pickBackfillEvents(lines: readonly string[], n: number): string[] {
  if (n <= 0) return [];
  const userLineIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ev = formatJsonlEvent(lines[i] ?? "");
    if (ev?.kind === "user") {
      userLineIndices.push(i);
    }
  }
  if (userLineIndices.length === 0) return [];
  const startIdx =
    userLineIndices.length <= n
      ? (userLineIndices[0] ?? 0)
      : (userLineIndices[userLineIndices.length - n] ?? 0);
  return lines.slice(startIdx);
}

function extractUserText(event: Record<string, unknown>): string {
  const message = event["message"];
  if (typeof message !== "object" || message === null) return "";
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (typeof c !== "object" || c === null) continue;
    const block = c as Record<string, unknown>;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      parts.push(block["text"]);
    }
  }
  return parts.join(" ").trim();
}

function stripWrapperTags(text: string): string {
  let out = text;
  for (let i = 0; i < 4; i++) {
    const m = /^\s*<([a-zA-Z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>\s*/m.exec(out);
    if (!m) break;
    out = out.slice(m[0].length);
  }
  return out;
}

/**
 * Split a formatted event message into ≤`maxLen`-char chunks so Telegram
 * doesn't truncate long QA at 4096. If the message has a "PREFIX：\nBODY"
 * shape (which formatJsonlEvent emits — "👤 你：" / "🤖 claude："), the
 * prefix is rewritten as "PREFIX (i/N)：" on each chunk so the user can
 * tell parts apart. Body splits prefer line breaks, then spaces, falling
 * back to a hard cut.
 *
 * Pure helper — exported for unit tests.
 */
export function chunkForTelegram(text: string, maxLen: number = MAX_TELEGRAM_TEXT): string[] {
  if (text.length <= maxLen) return [text];

  const nlIdx = text.indexOf("\n");
  if (nlIdx < 0) {
    return hardSplit(text, maxLen);
  }
  const prefix = text.slice(0, nlIdx);
  const body = text.slice(nlIdx + 1);

  // Worst-case label overhead: prefix + " (99/99)" = ~prefix.len + 9 chars.
  // Reserve 24 for safety so even prefixes with multi-byte trailing colons fit.
  const labelOverhead = prefix.length + 24;
  const bodyMax = Math.max(200, maxLen - labelOverhead);

  const bodyChunks = splitBody(body, bodyMax);
  if (bodyChunks.length === 1) {
    // Body fit after we re-checked against bodyMax — emit untouched.
    return [text];
  }

  // Strip trailing ":" / "：" so we can inject "(i/N)" before it.
  const colonMatch = prefix.match(/[:：]\s*$/);
  const colon = colonMatch ? colonMatch[0] : "";
  const baseLabel = colon ? prefix.slice(0, -colon.length) : prefix;

  const total = bodyChunks.length;
  return bodyChunks.map((chunk, i) => `${baseLabel} (${i + 1}/${total})${colon}\n${chunk}`);
}

function splitBody(body: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < body.length) {
    if (body.length - start <= maxLen) {
      chunks.push(body.slice(start));
      break;
    }
    const hardEnd = start + maxLen;
    // Prefer a newline near the cap (in the second half of the window).
    let cut = body.lastIndexOf("\n", hardEnd);
    if (cut <= start + maxLen * 0.5) {
      // Fall back to a space.
      cut = body.lastIndexOf(" ", hardEnd);
    }
    if (cut <= start + maxLen * 0.5) {
      // Last resort — hard cut at maxLen.
      cut = hardEnd;
      chunks.push(body.slice(start, cut));
      start = cut;
    } else {
      chunks.push(body.slice(start, cut));
      // Skip the boundary char so we don't start the next chunk with " " / "\n".
      start = cut + 1;
    }
  }
  return chunks;
}

function hardSplit(s: string, maxLen: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += maxLen) {
    out.push(s.slice(i, i + maxLen));
  }
  return out;
}

/**
 * Best-effort send of a one-shot "started" / "stopped" notice. Used by the
 * interactive handler so the user always sees a confirmation event. The
 * optional `messageThreadId` routes the notice into a forum topic when
 * follow is running in forum-routing mode; otherwise it lands in the chat
 * directly. Errors are swallowed via `sendBotMessage`'s structured return
 * shape — we discard non-ok results here because the caller already
 * surfaces the high-level outcome via the panel header.
 */
export async function notifyFollowEvent(
  token: string,
  chatId: string,
  text: string,
  messageThreadId?: number,
): Promise<void> {
  await sendBotMessage({
    botToken: token,
    chatId,
    text,
    messageThreadId,
  });
}

/**
 * Strip the chat id of `telegram:` prefix if openclaw's ctx hands it that way
 * (we hit this on overnight supervisor too). Returns the raw numeric id.
 */
export function normalizeTelegramChatId(raw: string): string {
  const m = raw.match(/^(?:[a-z][a-z0-9-]*:)?(-?\d+)(?::|$)/i);
  return m ? (m[1] ?? raw) : raw;
}

// Real-time "tail -f" of a claude session jsonl, streamed to Telegram as
// formatted user/assistant messages. Each new event becomes one Telegram
// message so the user can watch a session's progress on their phone without
// being at the laptop.
//
// 设计取舍：
// - 用 setInterval 2s 轮询而非 fs.watch —— fs.watch 跨平台行为不一致，
//   小项目的可靠性比 100ms-级实时性重要
// - 直发 Telegram bot API（同 overnight supervisor 路径），不经 openclaw
//   daemon 的 outbound channel —— 那条路径绑在 request scope，背景流不适配
// - daemon 由 openclaw-start.sh 注入 `NODE_OPTIONS=--use-env-proxy`，
//   所以 native fetch 自动走 https_proxy
// - 自动 30 min 上限（防忘了关）+ 每个 chat 只能 follow 一条 session
//   (registerFollow 会先 stop 旧的)
// - 只 surface 真实人类对话内容：filter isMeta / toolUseResult / 空 strip
//   后的 wrapper，跟 readSessionInfo 一致

import fs from "node:fs";
import path from "node:path";
import { type FollowHandle, registerFollow } from "./chat-state.js";
import { sessionsDir } from "./session-discovery.js";

const POLL_INTERVAL_MS = 2_000;
const AUTO_STOP_MS = 30 * 60 * 1000; // 30 min
const MAX_TELEGRAM_TEXT = 3_900; // <4096 with header / wrapping room

type FollowOptions = {
  chatKey: string;
  sessionId: string;
  cwd: string;
  telegramChatId: string;
  telegramBotToken: string;
};

export function startFollow(opts: FollowOptions): FollowHandle | null {
  const jsonlPath = path.join(sessionsDir(opts.cwd), `${opts.sessionId}.jsonl`);
  let lastSize: number;
  try {
    lastSize = fs.statSync(jsonlPath).size;
  } catch {
    return null;
  }

  let stopped = false;
  let inflight: Promise<void> = Promise.resolve();

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
      const formatted = formatJsonlEvent(line);
      if (!formatted) continue;
      await sendTelegramMessage(opts.telegramBotToken, opts.telegramChatId, formatted);
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
    void sendTelegramMessage(
      opts.telegramBotToken,
      opts.telegramChatId,
      `⏹ follow 自动停止（30 分钟上限） · sid=\`${opts.sessionId.slice(0, 8)}\``,
    );
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

/**
 * Parse a jsonl line and format as Telegram message text.
 * Returns null when the event is not user-facing (system/meta/tool_result).
 */
function formatJsonlEvent(line: string): string | null {
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
    return `👤 你：\n${truncate(cleaned, MAX_TELEGRAM_TEXT - 10)}`;
  }

  if (type === "assistant") {
    const message = obj["message"];
    if (typeof message !== "object" || message === null) return null;
    const content = (message as Record<string, unknown>)["content"];
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const c of content) {
      if (typeof c !== "object" || c === null) continue;
      const block = c as Record<string, unknown>;
      if (block["type"] === "text" && typeof block["text"] === "string") {
        parts.push(block["text"]);
      } else if (block["type"] === "tool_use" && typeof block["name"] === "string") {
        parts.push(`[🛠 ${block["name"]}]`);
      }
    }
    const text = parts.join("\n").trim();
    if (!text) return null;
    return `🤖 claude：\n${truncate(text, MAX_TELEGRAM_TEXT - 12)}`;
  }

  return null;
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

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Direct Telegram bot API call. Daemon-side fetch with proxy support via
 * `NODE_OPTIONS=--use-env-proxy` (injected by scripts/openclaw-start.sh).
 * Errors logged to stderr, never throw — follow loop should keep ticking.
 */
async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<void> {
  if (!token) {
    process.stderr.write("[follow] TG token missing, skipping send\n");
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      process.stderr.write(`[follow] telegram send rc=${res.status} body=${body.slice(0, 200)}\n`);
    }
  } catch (err) {
    const e = err as { name?: string; message?: string; cause?: { code?: string } };
    process.stderr.write(
      `[follow] telegram send error: name=${e?.name} message=${e?.message} cause=${e?.cause?.code}\n`,
    );
  }
}

/**
 * Best-effort send of a one-shot "started" / "stopped" notice. Used by the
 * interactive handler so the user always sees a confirmation event.
 */
export async function notifyFollowEvent(
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  await sendTelegramMessage(token, chatId, text);
}

/**
 * Strip the chat id of `telegram:` prefix if openclaw's ctx hands it that way
 * (we hit this on overnight supervisor too). Returns the raw numeric id.
 */
export function normalizeTelegramChatId(raw: string): string {
  const m = raw.match(/^(?:[a-z][a-z0-9-]*:)?(-?\d+)(?::|$)/i);
  return m ? (m[1] ?? raw) : raw;
}

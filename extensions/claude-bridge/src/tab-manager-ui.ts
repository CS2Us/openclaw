// Pool-driven panel renderer for `/claude` (Telegram).
//
// 设计变更（2026-05-11）：panel 现在以 "claude session pool" 为真相源，
// 不再以 bot 的 state.tabs 为列表来源。具体：
//
//   1. /claude 入口 (command.ts) 读 ~/.claude/projects/<cwd>/*.jsonl 按 mtime
//      desc 排序取前 3 → 渲染为 panel
//   2. 用数字代号 1/2/3 标识，点击 [N] button → switch 到对应 session
//   3. switch 时通过 `respond.reply` 发**新** panel 消息（不是 editMessage），
//      在 chat 历史里留分界线，体感"开新聊天界面"
//   4. 顶部 [+ 新 session] button 起一条新 session（也走 reply）
//
// Callback wire format: `<INTERACTIVE_NAMESPACE>:<action>[:<arg>]`.
// Telegram callback_data hard-caps at 64 bytes; sessionId 是 UUID 36 字符 +
// "cb:sw:" 6 字符 = 42 字符，安全。

import type { InteractiveReply } from "openclaw/plugin-sdk/interactive-runtime";

/** Single source of truth for the interactive callback namespace. */
export const INTERACTIVE_NAMESPACE = "cb";

/** Action codes. Two-letter prefixes leave room for session ids in 64 bytes. */
export const ACTION = {
  switch: "sw",
  newTab: "nw",
  refresh: "rf",
  follow: "fo", // start real-time tail of active session into telegram
  unfollow: "uf", // stop the current follow
  // Legacy action codes parsed (so stale callback_data in chat history doesn't
  // error out) but no longer rendered as buttons.
  closeTab: "cl",
  resetAll: "rs",
  importSession: "im",
} as const;

export type ParsedCallback =
  | { kind: "switch"; sessionId: string }
  | { kind: "newTab" }
  | { kind: "refresh" }
  | { kind: "follow" }
  | { kind: "unfollow" }
  | { kind: "closeTab"; tabId: string }
  | { kind: "resetAll" }
  | { kind: "import"; sessionId: string }
  | { kind: "unknown"; raw: string };

export function parseCallbackPayload(payload: string): ParsedCallback {
  const [action, ...rest] = payload.split(":");
  switch (action) {
    case ACTION.switch:
      return { kind: "switch", sessionId: rest.join(":") };
    case ACTION.newTab:
      return { kind: "newTab" };
    case ACTION.refresh:
      return { kind: "refresh" };
    case ACTION.follow:
      return { kind: "follow" };
    case ACTION.unfollow:
      return { kind: "unfollow" };
    case ACTION.closeTab:
      return { kind: "closeTab", tabId: rest.join(":") };
    case ACTION.resetAll:
      return { kind: "resetAll" };
    case ACTION.importSession:
      return { kind: "import", sessionId: rest.join(":") };
    default:
      return { kind: "unknown", raw: payload };
  }
}

export function buildCallbackData(action: string, arg?: string): string {
  return arg ? `${INTERACTIVE_NAMESPACE}:${action}:${arg}` : `${INTERACTIVE_NAMESPACE}:${action}`;
}

const ACTIVE_DOT = "●";
const MAX_PANEL_ENTRIES = 3;

export type PanelEntry = {
  /** Full session UUID (uniquely identifies a jsonl in ~/.claude/projects/<cwd>/). */
  sessionId: string;
  /** First user prompt preview (or null if jsonl unreadable / empty). */
  preview: string | null;
  /** mtime of the jsonl (most recent activity). */
  lastActivityMs: number;
};

export type RenderPanelInput = {
  /** Pool entries sorted by activity desc; only first MAX_PANEL_ENTRIES rendered. */
  entries: readonly PanelEntry[];
  /** Currently-active session for routing user input (may not be in entries). */
  activeSessionId: string | null;
  /** Optional header to indicate "switched to" context (used after switch action). */
  header?: string;
  /** True = follow stream is running for this chat (render `[⏹ 停止流]` instead of `[👁 实时流]`). */
  followActive?: boolean;
};

function formatActivityShort(ms: number, nowMs: number = Date.now()): string {
  const diffMin = Math.max(0, Math.round((nowMs - ms) / 60_000));
  if (diffMin < 1) return "刚才";
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}小时前`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}天前`;
}

function shortPreview(preview: string | null, max: number = 40): string {
  if (!preview) return "(无 user prompt)";
  return preview.length > max ? `${preview.slice(0, max)}…` : preview;
}

/**
 * Render the /claude panel.
 *
 * Layout:
 * - Optional header (e.g. "📍 切到 session X")
 * - Numbered list of top-3 pool sessions: "●1 <relative-time> | <preview>"
 * - Top button: [+ 新 session]
 * - Switch button row: [●1] [2] [3]
 */
export function renderPanel(input: RenderPanelInput): {
  text: string;
  interactive: InteractiveReply;
} {
  const entries = input.entries.slice(0, MAX_PANEL_ENTRIES);
  const lines: string[] = [];

  if (input.header) {
    lines.push(input.header);
    lines.push("");
  }

  if (entries.length === 0) {
    lines.push("📜 还没有 claude session。点 [+ 新 session] 起一个。");
  } else {
    lines.push("📜 最近 claude session（按活跃时间）：");
    lines.push("");
    entries.forEach((entry, idx) => {
      const code = idx + 1;
      const active = entry.sessionId === input.activeSessionId;
      const marker = active ? `${ACTIVE_DOT}${code}` : ` ${code}`;
      const when = formatActivityShort(entry.lastActivityMs);
      const sidShort = entry.sessionId.slice(0, 8);
      lines.push(`${marker}  \`${sidShort}\`  ${when}  ${shortPreview(entry.preview)}`);
    });
  }

  const buttonRows: InteractiveReply["blocks"] = [];

  // Top row: [+ 新 session]  + 可选 [👁 实时流]/[⏹ 停止流]
  const topButtons: Array<{
    label: string;
    value: string;
    style?: "primary" | "danger" | "success";
  }> = [{ label: "+ 新 session", value: buildCallbackData(ACTION.newTab), style: "primary" }];
  if (input.followActive) {
    topButtons.push({
      label: "⏹ 停止流",
      value: buildCallbackData(ACTION.unfollow),
      style: "danger",
    });
  } else if (input.activeSessionId) {
    // 只有当 user 已经切到一条 session 时才显示 follow 按钮
    topButtons.push({
      label: "👁 实时流",
      value: buildCallbackData(ACTION.follow),
    });
  }
  buttonRows.push({ type: "buttons", buttons: topButtons });

  // Switch row: [●1] [2] [3] ... — only render buttons for actual entries.
  if (entries.length > 0) {
    buttonRows.push({
      type: "buttons",
      buttons: entries.map((entry, idx) => {
        const code = idx + 1;
        const active = entry.sessionId === input.activeSessionId;
        return {
          label: active ? `${ACTIVE_DOT}${code}` : `${code}`,
          value: buildCallbackData(ACTION.switch, entry.sessionId),
        };
      }),
    });
  }

  return {
    text: lines.join("\n"),
    interactive: { blocks: buttonRows },
  };
}

/**
 * @deprecated 留作 backward-compat shim 直到 callers 全切到 renderPanel。
 * 没有 pool 数据时空 render（旧 state.tabs 概念已废）。
 */
export function renderTabManager(): { text: string; interactive: InteractiveReply } {
  return renderPanel({ entries: [], activeSessionId: null });
}

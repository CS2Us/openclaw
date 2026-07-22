// Pool-driven panel renderer for `/agent` (Telegram).
//
// 设计变更（2026-05-11）：panel 现在以 "agent session pool" 为真相源，
// 不再以 bot 的 state.tabs 为列表来源。具体：
//
//   1. /agent 入口 (command.ts) 读 ~/.claude/projects/<cwd>/*.jsonl 按 mtime
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
  // One-tap "enter session + auto-follow + replay last turn". Used by the
  // approval-companion message (perm-hook.cjs) so the user can step into the
  // session that triggered an approval card without manually opening /agent.
  // Payload: cb:ef:<sessionId>
  enterAndFollow: "ef",
  // Approval decision from agent-bridge's *own* approval card sent directly
  // by perm-hook.cjs. Bypasses openclaw's standard channel approval handler
  // delivery (which was unreliable through Clash proxy). Decision shortcodes:
  // a1=allow-once, aa=allow-always, dn=deny. Payload:
  //   cb:ad:<approvalId>:<a1|aa|dn>
  // Interactive handler calls plugin.approval.resolve via the loopback WS
  // client (daemon-gateway-client.ts); perm-hook's waitDecision returns
  // instantly via the gateway's resolved event — no file IPC.
  approveDecision: "ad",
  // Legacy action codes parsed (so stale callback_data in chat history doesn't
  // error out) but no longer rendered as buttons.
  closeTab: "cl",
  resetAll: "rs",
  importSession: "im",
} as const;

export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

export type ParsedCallback =
  | { kind: "switch"; sessionId: string }
  | { kind: "newTab" }
  | { kind: "refresh" }
  | { kind: "follow" }
  | { kind: "unfollow" }
  | { kind: "enterAndFollow"; sessionId: string }
  | { kind: "approveDecision"; approvalId: string; decision: ApprovalDecision }
  | { kind: "closeTab"; tabId: string }
  | { kind: "resetAll" }
  | { kind: "import"; sessionId: string }
  | { kind: "unknown"; raw: string };

const APPROVAL_DECISION_SHORTCODES: Record<string, ApprovalDecision> = {
  a1: "allow-once",
  aa: "allow-always",
  dn: "deny",
};

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
    case ACTION.enterAndFollow:
      return { kind: "enterAndFollow", sessionId: rest.join(":") };
    case ACTION.approveDecision: {
      // Payload format: cb:ad:<approvalId>:<shortcode>. approvalId may contain
      // colons (UUIDs don't, but be defensive); shortcode is the *last* part.
      if (rest.length < 2) return { kind: "unknown", raw: payload };
      const shortcode = rest[rest.length - 1];
      const approvalId = rest.slice(0, -1).join(":");
      const decision = APPROVAL_DECISION_SHORTCODES[shortcode];
      if (!approvalId || !decision) return { kind: "unknown", raw: payload };
      return { kind: "approveDecision", approvalId, decision };
    }
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
 * Render the /agent panel.
 *
 * Layout:
 * - Optional header (e.g. "📍 切到 session X")
 * - "📌 当前: <sid> <preview>" line — *only* when activeSessionId is in entries
 * - Numbered list of OTHER sessions (current excluded): " 1 <sid> <time> <preview>"
 * - Top buttons: [+ 新 session] + (live follow toggle when active)
 * - Switch button row: [1] [2] [3] — for the OTHERS only; clicking switches
 *   to that other session
 *
 * Design rationale: plain DM continues the current session (no click needed),
 * so the current session doesn't need to be a switch target. Surface it as a
 * "you're here" badge; let the numbered list be a pure menu of switch
 * candidates — fewer mental steps + no "click 1 when 1 is already current".
 */
export function renderPanel(input: RenderPanelInput): {
  text: string;
  interactive: InteractiveReply;
} {
  // Pool can include the current session — separate it out so the numbered
  // switch list contains only candidates the user could meaningfully jump to.
  const allEntries = input.entries;
  const currentEntry =
    input.activeSessionId != null
      ? (allEntries.find((e) => e.sessionId === input.activeSessionId) ?? null)
      : null;
  const otherEntries = allEntries
    .filter((e) => e.sessionId !== input.activeSessionId)
    .slice(0, MAX_PANEL_ENTRIES);

  const lines: string[] = [];

  if (input.header) {
    lines.push(input.header);
    lines.push("");
  }

  if (currentEntry) {
    const sidShort = currentEntry.sessionId.slice(0, 8);
    lines.push(
      `📌 当前: \`${sidShort}\`  ${shortPreview(currentEntry.preview)}  · plain DM 直接续聊`,
    );
    lines.push("");
  } else if (input.activeSessionId) {
    // Active session not in pool — likely a fresh tab with no jsonl yet.
    lines.push(`📌 当前: \`${input.activeSessionId.slice(0, 8)}\`  (新会话 · 待首条消息)`);
    lines.push("");
  }

  if (otherEntries.length === 0) {
    if (!currentEntry && !input.activeSessionId) {
      lines.push("📜 还没有 agent session。点 [+ 新 session] 起一个。");
    } else {
      lines.push("📜 没有其他可切的 session。");
    }
  } else {
    lines.push("📜 切到其他 session：");
    lines.push("");
    otherEntries.forEach((entry, idx) => {
      const code = idx + 1;
      const when = formatActivityShort(entry.lastActivityMs);
      const sidShort = entry.sessionId.slice(0, 8);
      lines.push(` ${code}  \`${sidShort}\`  ${when}  ${shortPreview(entry.preview)}`);
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

  // Switch row: [1] [2] [3] ... — others only; current is a header badge so
  // no ●N variant is needed (we already filtered current out).
  if (otherEntries.length > 0) {
    buttonRows.push({
      type: "buttons",
      buttons: otherEntries.map((entry, idx) => ({
        label: `${idx + 1}`,
        value: buildCallbackData(ACTION.switch, entry.sessionId),
      })),
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

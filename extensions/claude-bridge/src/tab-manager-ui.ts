// Pure helpers that turn ChatState into the InteractiveReply blocks rendered
// by `/claude` and refreshed by the InteractiveHandler. Keeping these pure
// (no side effects, no runtime reads) lets us unit-test the UI shape without
// stubbing telegram / openclaw runtime.
//
// Callback wire format: `<INTERACTIVE_NAMESPACE>:<action>[:<arg>]`.
// Telegram callback_data hard-caps at 64 bytes, including the namespace and
// separator — keep namespace + actions terse.

import type { InteractiveReply } from "openclaw/plugin-sdk/interactive-runtime";
import type { ChatState } from "./chat-state.js";

/** Single source of truth for the interactive callback namespace. */
export const INTERACTIVE_NAMESPACE = "cb";

/** Action codes. Two-letter prefixes leave room for tab ids / session ids in 64 bytes. */
export const ACTION = {
  switch: "sw",
  newTab: "nw",
  closeTab: "cl",
  resetAll: "rs",
  refresh: "rf",
  importSession: "im",
} as const;

export type ParsedCallback =
  | { kind: "switch"; tabId: string }
  | { kind: "newTab" }
  | { kind: "closeTab"; tabId: string }
  | { kind: "resetAll" }
  | { kind: "refresh" }
  | { kind: "import"; sessionId: string }
  | { kind: "unknown"; raw: string };

/**
 * Parse the payload portion of a callback (the part after `cb:`). The
 * dispatcher already strips `<namespace>:` and hands us only the action
 * portion in `ctx.callback.payload`.
 */
export function parseCallbackPayload(payload: string): ParsedCallback {
  const [action, ...rest] = payload.split(":");
  switch (action) {
    case ACTION.switch:
      return { kind: "switch", tabId: rest.join(":") };
    case ACTION.newTab:
      return { kind: "newTab" };
    case ACTION.closeTab:
      return { kind: "closeTab", tabId: rest.join(":") };
    case ACTION.resetAll:
      return { kind: "resetAll" };
    case ACTION.refresh:
      return { kind: "refresh" };
    case ACTION.importSession:
      return { kind: "import", sessionId: rest.join(":") };
    default:
      return { kind: "unknown", raw: payload };
  }
}

/** Subset of `SessionInfo` that the UI needs — keeps the rendering pure and
 *  testable without importing fs-bound modules. */
export type LocalSessionSummary = {
  sessionId: string;
  preview: string | null;
  eventCount: number;
};

export function buildCallbackData(action: string, arg?: string): string {
  return arg ? `${INTERACTIVE_NAMESPACE}:${action}:${arg}` : `${INTERACTIVE_NAMESPACE}:${action}`;
}

const ACTIVE_DOT = "●";
const MAX_LABEL_IN_BUTTON = 18; // keeps callback_data + label under telegram's row width sanity
const TABS_PER_ROW = 6; // telegram allows up to 8 buttons/row; 6 keeps codes readable

function truncateLabel(label: string, max = MAX_LABEL_IN_BUTTON): string {
  if (label.length <= max) {
    return label;
  }
  return `${label.slice(0, max - 1)}…`;
}

/**
 * Render the tab manager: a text summary plus a buttons block.
 * Layout:
 * - Top row: [+ 新 session] (always visible, prominent default).
 * - Tab-code rows: compact `[●1] [2] [3] …`, packed up to TABS_PER_ROW per row.
 *   The text section above maps each code to its full label.
 * - Danger row: [× 关闭当前] [🗑 重置全部] (only when applicable).
 * - Recent-local-session rows: one `[↓ <preview>]` per importable jsonl.
 */
export function renderTabManager(
  state: ChatState,
  opts?: { recentLocalSessions?: readonly LocalSessionSummary[] },
): {
  text: string;
  interactive: InteractiveReply;
} {
  const lines: string[] = [];
  if (state.tabs.length === 0) {
    lines.push("还没有 tab。点 [+ 新 session] 起一个。");
  } else {
    lines.push(`Tabs (${state.tabs.length})：`);
    state.tabs.forEach((t, idx) => {
      const active = t.id === state.activeTabId;
      const code = idx + 1;
      const sid = t.sessionId ? `\`${t.sessionId.slice(0, 8)}\`` : "未起 session";
      const marker = active ? `${ACTIVE_DOT}${code}` : ` ${code}`;
      lines.push(`${marker}. **${t.label}** — ${sid}`);
    });
  }

  const buttonRows: InteractiveReply["blocks"] = [];

  // Top row: [+ 新 session] — always present so users can always start fresh.
  buttonRows.push({
    type: "buttons",
    buttons: [{ label: "+ 新 session", value: buildCallbackData(ACTION.newTab), style: "primary" }],
  });

  // Compact tab-code rows: positional index keyed to text section above.
  for (let i = 0; i < state.tabs.length; i += TABS_PER_ROW) {
    const slice = state.tabs.slice(i, i + TABS_PER_ROW);
    buttonRows.push({
      type: "buttons",
      buttons: slice.map((t, j) => {
        const active = t.id === state.activeTabId;
        const code = i + j + 1;
        return {
          label: active ? `${ACTIVE_DOT}${code}` : `${code}`,
          value: buildCallbackData(ACTION.switch, t.id),
        };
      }),
    });
  }

  // Danger row: only show buttons that are meaningful for the current state.
  const dangerActions: {
    label: string;
    value: string;
    style?: "primary" | "danger" | "secondary";
  }[] = [];
  if (state.activeTabId) {
    dangerActions.push({
      label: "× 关闭当前",
      value: buildCallbackData(ACTION.closeTab, state.activeTabId),
    });
  }
  if (state.tabs.length > 0) {
    dangerActions.push({
      label: "🗑 重置全部",
      value: buildCallbackData(ACTION.resetAll),
      style: "danger",
    });
  }
  if (dangerActions.length > 0) {
    buttonRows.push({ type: "buttons", buttons: dangerActions });
  }

  // Recent local sessions section (post-actions so primary controls stay on top).
  const recent = opts?.recentLocalSessions ?? [];
  if (recent.length > 0) {
    lines.push("");
    lines.push("最近本地 session（点导入为新 tab）：");
    for (const s of recent) {
      const previewLine = s.preview ?? "(no preview)";
      lines.push(`• ${truncateLabel(previewLine, 60)} — \`${s.sessionId.slice(0, 8)}\``);
    }
    // One row per import button — preview text can be long, keep readable.
    for (const s of recent) {
      const previewLabel = s.preview
        ? truncateLabel(s.preview, MAX_LABEL_IN_BUTTON)
        : `Session ${s.sessionId.slice(0, 8)}`;
      buttonRows.push({
        type: "buttons",
        buttons: [
          {
            label: `↓ ${previewLabel}`,
            value: buildCallbackData(ACTION.importSession, s.sessionId),
          },
        ],
      });
    }
  }

  return {
    text: lines.join("\n"),
    interactive: { blocks: buttonRows },
  };
}

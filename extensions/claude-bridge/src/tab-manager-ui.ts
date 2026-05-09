// Pure helpers that turn ChatState into the InteractiveReply blocks rendered
// by `/claude` and refreshed by the InteractiveHandler. Keeping these pure
// (no side effects, no runtime reads) lets us unit-test the UI shape without
// stubbing telegram / openclaw runtime.
//
// Callback wire format: `<INTERACTIVE_NAMESPACE>:<action>[:<arg>]`.
// Telegram callback_data hard-caps at 64 bytes, including the namespace and
// separator — keep namespace + actions terse.
//
// The visible UI is intentionally minimal: a list of session titles + a
// [+ 新 session] button + numbered switch buttons. Close / reset / import
// affordances were removed at user request — tabs are evicted automatically
// (LRU at MAX_TABS) so the user never has to manage them by hand. The legacy
// `closeTab` / `resetAll` / `importSession` action codes are still parsed so
// stale buttons in chat history don't error out, but nothing renders them.

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

export function buildCallbackData(action: string, arg?: string): string {
  return arg ? `${INTERACTIVE_NAMESPACE}:${action}:${arg}` : `${INTERACTIVE_NAMESPACE}:${action}`;
}

const ACTIVE_DOT = "●";
const TABS_PER_ROW = 6; // telegram allows up to 8 buttons/row; 6 keeps codes readable

/**
 * Render the tab manager: list of session titles + new-session button +
 * numbered switch buttons. Nothing else.
 *
 * Layout:
 * - Text: numbered titles, e.g. `●1. <first question of session>`.
 * - Top row: [+ 新 session].
 * - Tab-code rows: `[●1] [2] [3] …`, packed up to TABS_PER_ROW per row.
 */
export function renderTabManager(state: ChatState): {
  text: string;
  interactive: InteractiveReply;
} {
  const lines: string[] = [];
  if (state.tabs.length === 0) {
    lines.push("还没有会话。点 [+ 新 session] 起一个。");
  } else {
    state.tabs.forEach((t, idx) => {
      const active = t.id === state.activeTabId;
      const code = idx + 1;
      const marker = active ? `${ACTIVE_DOT}${code}` : ` ${code}`;
      lines.push(`${marker}. **${t.label}**`);
    });
  }

  const buttonRows: InteractiveReply["blocks"] = [];

  // Top row: [+ 新 session].
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

  return {
    text: lines.join("\n"),
    interactive: { blocks: buttonRows },
  };
}

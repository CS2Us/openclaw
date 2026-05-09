// Tab-manager interactive handler. Receives Telegram inline-keyboard taps,
// mutates ChatState, and re-renders the manager UI in place via
// `respond.editMessage` for direct, single-tap interaction.
//
// We use the generic `PluginInteractiveHandlerRegistration` from the plugin
// SDK and locally mirror the Telegram-specific context shape — the
// `extensions/telegram/api.ts` barrel cannot be imported from another
// extension per the bundled-extension boundary rules. The structural mirror
// is fine because TS is structural; if the channel ever broadens the context
// shape, our local type just gets stale and the handler keeps compiling.

import type { InteractiveReplyBlock } from "openclaw/plugin-sdk/interactive-runtime";
import type { PluginInteractiveHandlerRegistration } from "openclaw/plugin-sdk/plugin-runtime";
import {
  chatStateKey,
  closeTab,
  createNewTab,
  getOrCreateChatState,
  importSessionAsTab,
  resetChatState,
  switchActiveTab,
} from "./chat-state.js";
import { INTERACTIVE_NAMESPACE, parseCallbackPayload, renderTabManager } from "./tab-manager-ui.js";

type TelegramButton = {
  text: string;
  callback_data: string;
  style?: "danger" | "success" | "primary";
};
type TelegramButtons = Array<Array<TelegramButton>>;

type TelegramInteractiveCtx = {
  channel: "telegram";
  callback: { payload: string; chatId: string };
  auth: { isAuthorizedSender: boolean };
  respond: {
    editMessage: (params: { text: string; buttons?: TelegramButtons }) => Promise<void>;
  };
};

export function createTabManagerInteractiveHandler(_options?: {
  pluginConfig?: unknown;
}): PluginInteractiveHandlerRegistration {
  return {
    channel: "telegram",
    namespace: INTERACTIVE_NAMESPACE,
    handler: async (ctx) => {
      const t = ctx as TelegramInteractiveCtx;
      // Telegram extension already screens inbound traffic against
      // `allowFrom`; this is a paranoid second check on the async callback
      // path, where dispatch races could in principle land from elsewhere.
      if (!t.auth.isAuthorizedSender) {
        return { handled: true };
      }

      const key = chatStateKey("telegram", t.callback.chatId);
      const parsed = parseCallbackPayload(t.callback.payload);
      // closeTab / resetAll / import are no longer rendered as buttons but the
      // parser still recognizes them so stale callback_data from old messages
      // in chat history still works (defensive — see file header).
      switch (parsed.kind) {
        case "switch":
          switchActiveTab(key, parsed.tabId);
          break;
        case "newTab":
          createNewTab(key);
          break;
        case "closeTab":
          closeTab(key, parsed.tabId);
          break;
        case "resetAll":
          resetChatState(key);
          break;
        case "import":
          importSessionAsTab(key, parsed.sessionId);
          break;
        case "refresh":
        case "unknown":
          // No state mutation; just re-render so the user sees the UI is alive.
          break;
      }

      const state = getOrCreateChatState(key);
      const refreshed = renderTabManager(state);
      await t.respond.editMessage({
        text: refreshed.text,
        buttons: interactiveBlocksToTelegramButtons(refreshed.interactive.blocks),
      });

      return { handled: true };
    },
  };
}

function interactiveBlocksToTelegramButtons(
  blocks: readonly InteractiveReplyBlock[],
): TelegramButtons {
  const rows: TelegramButtons = [];
  for (const block of blocks) {
    if (block.type !== "buttons") {
      continue;
    }
    const row = block.buttons
      .filter(
        (btn): btn is { label: string; value: string; style?: TelegramButton["style"] } =>
          typeof btn.value === "string" && btn.value.length > 0,
      )
      .map((btn): TelegramButton => {
        const out: TelegramButton = { text: btn.label, callback_data: btn.value };
        if (isTelegramStyle(btn.style)) {
          out.style = btn.style;
        }
        return out;
      });
    if (row.length > 0) {
      rows.push(row);
    }
  }
  return rows;
}

function isTelegramStyle(s: unknown): s is TelegramButton["style"] {
  return s === "danger" || s === "success" || s === "primary";
}

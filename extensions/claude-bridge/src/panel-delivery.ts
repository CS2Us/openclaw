// "Single panel" delivery primitive — used by both the /claude command path
// (where the user typed /claude and we want to reuse / replace the prior
// panel) and the interactive callback path (button taps that should edit
// the panel in place, including taps that originated outside the panel
// itself — e.g. enterAndFollow on an approval card should edit the panel,
// not turn the approval card into a panel).
//
// Behavior:
//   1. If a panel id is on record AND its chatId matches: try editMessageText.
//      On success, update the timestamp in the store and we're done.
//   2. On miss / edit failure: send a fresh message. If we had a stale id,
//      best-effort deleteMessage it so the chat still ends up with exactly
//      one panel.
//   3. Persist the new message id.

import type { InteractiveReplyBlock } from "openclaw/plugin-sdk/interactive-runtime";
import { clearPanelId, getPanelId, setPanelId } from "./panel-id-store.js";
import {
  deleteMessage,
  editMessageText,
  type InlineKeyboardMarkup,
  sendBotMessage,
} from "./telegram-bot-api.js";

export type DeliverPanelInput = {
  chatKey: string;
  chatId: string;
  botToken: string;
  text: string;
  blocks: readonly InteractiveReplyBlock[];
};

export async function deliverPanel(input: DeliverPanelInput): Promise<void> {
  const { chatKey, chatId, botToken, text } = input;
  const replyMarkup = interactiveBlocksToInlineKeyboard(input.blocks);

  const existing = getPanelId(chatKey);
  if (existing && existing.chatId === chatId) {
    const edited = await editMessageText({
      botToken,
      chatId,
      messageId: existing.messageId,
      text,
      parseMode: "Markdown",
      replyMarkup,
    });
    if (edited.ok) {
      setPanelId(chatKey, {
        chatId,
        messageId: existing.messageId,
        updatedAt: Date.now(),
      });
      return;
    }
    // Common edit failures: "message to edit not found" (user deleted),
    // "message is not modified" (identical content — also benign, we should
    // still keep the id). Distinguish via description.
    if (edited.description?.includes("message is not modified")) {
      setPanelId(chatKey, {
        chatId,
        messageId: existing.messageId,
        updatedAt: Date.now(),
      });
      return;
    }
    // Fall through to send-fresh path; the old id is dead.
  }

  const sent = await sendBotMessage({
    botToken,
    chatId,
    text,
    parseMode: "Markdown",
    replyMarkup,
  });
  if (!sent.ok) {
    // If we had a prior id, leave it intact — next attempt may succeed.
    return;
  }

  // Best-effort: delete the stale panel so the chat ends with a single
  // panel message. If the stale id is already gone (deleted, expired) this
  // 404s and we ignore it.
  if (existing && existing.chatId === chatId && existing.messageId !== sent.messageId) {
    void deleteMessage({
      botToken,
      chatId,
      messageId: existing.messageId,
    });
  }

  setPanelId(chatKey, {
    chatId,
    messageId: sent.messageId,
    updatedAt: Date.now(),
  });
}

/**
 * Clear the persisted panel id without sending anything. Used when the
 * panel is known to be gone (e.g. caller already deleted it explicitly).
 */
export function forgetPanel(chatKey: string): void {
  clearPanelId(chatKey);
}

/**
 * Maps openclaw's channel-agnostic `interactive.blocks` (used by
 * tab-manager-ui's renderPanel) to a Telegram inline keyboard. Only
 * "buttons" blocks become rows; non-button blocks are dropped (they have
 * no Telegram counterpart in this surface). Buttons missing a callback
 * value are dropped because Telegram requires `callback_data` for
 * non-link buttons.
 */
function interactiveBlocksToInlineKeyboard(
  blocks: readonly InteractiveReplyBlock[],
): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (const block of blocks) {
    if (block.type !== "buttons") continue;
    const row = block.buttons
      .filter(
        (btn): btn is { label: string; value: string } =>
          typeof btn.value === "string" && btn.value.length > 0,
      )
      .map((btn) => ({ text: btn.label, callback_data: btn.value }));
    if (row.length > 0) {
      rows.push(row);
    }
  }
  return { inline_keyboard: rows };
}

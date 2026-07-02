// Telegram DM fallthrough handler —— default path for plain DMs.
// sub-spec chromite-harness-openclaw-bridge-v1 §3 决策 #A.

import type {
  PluginInboundFallthroughEvent,
  PluginInboundFallthroughHandler,
  PluginInboundFallthroughResult,
} from "openclaw/plugin-sdk/plugin-runtime";
import { dispatchChromiteRound } from "./handler.js";

export function createChromiteBridgeFallthroughHandler(options: {
  pluginConfig?: unknown;
}): PluginInboundFallthroughHandler {
  return async (event: PluginInboundFallthroughEvent): Promise<PluginInboundFallthroughResult> => {
    const text = (event.text ?? "").trim();
    if (!text) {
      return { handled: false };
    }
    const result = await dispatchChromiteRound({
      chatId: event.chatId,
      accountId: event.accountId,
      text,
      // resolution-middleware-v1 §2 #D: PluginInboundFallthroughEvent does NOT
      // expose senderId; for telegram DM private chat we treat chatId as the
      // sender's user_id (chat.id == user.id in 1-on-1 DM). Breaks for group
      // chats — single-user-DM is the v1 invariant.
      senderId: event.chatId,
      pluginConfig: options.pluginConfig,
    });
    return { handled: true, reply: result.reply, interactive: result.interactive };
  };
}

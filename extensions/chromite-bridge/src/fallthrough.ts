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
      pluginConfig: options.pluginConfig,
    });
    return { handled: true, reply: result.reply };
  };
}

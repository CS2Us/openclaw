// /chromite command registration —— explicit trigger path.
// sub-spec chromite-harness-openclaw-bridge-v1 §3 决策 #A.

import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { dispatchChromiteRound, stripChromitePrefix } from "./handler.js";

export function createChromiteCommand(options: {
  pluginConfig?: unknown;
}): OpenClawPluginCommandDefinition {
  return {
    name: "chromite",
    description:
      "Send the rest of the message to local chromite-server (AI commerce agent). " +
      "Plain DMs reach the same agent via fallthrough; this command is an explicit alias.",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleChromiteCommand(ctx, options),
  };
}

async function handleChromiteCommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown },
): Promise<PluginCommandResult> {
  const body = stripChromitePrefix((ctx.args ?? "").trim() || ctx.commandBody.trim());
  const chatId = ctx.to ?? ctx.from ?? "";
  if (!chatId) {
    return { text: "chromite-bridge: missing chat id (no `to`/`from` in command context)." };
  }
  if (!body) {
    return {
      text: "用法：`/chromite <消息>`，或直接发普通消息（DM 默认进 chromite）。",
    };
  }
  const result = await dispatchChromiteRound({
    chatId,
    accountId: ctx.accountId,
    text: body,
    senderId: ctx.senderId,
    pluginConfig: options.pluginConfig,
  });
  return { text: result.reply };
}

import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { resetChatState, updateChatStateAfterTurn } from "./chat-state.js";
import {
  resolveDefaults,
  resolveProjectCwd,
  runClaude,
  truncate,
  type ClaudeBridgeConfig,
} from "./handler.js";
import {
  buildPermHookEnv,
  resolveGatewayPassword,
  resolveGatewayUrl,
  resolvePermHookScriptPath,
} from "./perm-hook-spawn.js";

export function createClaudeCommand(options: {
  pluginConfig?: unknown;
}): OpenClawPluginCommandDefinition {
  return {
    name: "claude",
    description:
      "Reset the bridged Claude Code session for this chat. Plain DMs continue the same session; use this to start fresh. Pass an optional first message after the command.",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleClaudeCommand(ctx, options),
  };
}

async function handleClaudeCommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown },
): Promise<PluginCommandResult> {
  const config = (options.pluginConfig ?? {}) as ClaudeBridgeConfig;

  const key = resolveChatKey(ctx);
  if (!key) {
    return { text: "claude-bridge: 无法解析 chat 标识，命令无效" };
  }

  // §3.2 trigger table: `/claude` always resets the session, regardless of
  // whether args are supplied. With no args we just reply "session reset"; with
  // args we additionally spawn a fresh claude turn (no --resume) so the args
  // become the first message of the new session.
  resetChatState(key);

  const prompt = ctx.args?.trim() ?? "";
  if (!prompt) {
    return {
      text:
        "新会话已开启。直接给 bot 发消息即可继续，无需每次都打 /claude。\n" +
        "再次发送 /claude 会重置会话。",
    };
  }

  const projectCwd = resolveProjectCwd(config);
  if (!projectCwd) {
    return {
      text:
        "claude-bridge: projectCwd is not configured.\n" +
        "Set it via plugin config (`projectCwd`) or env `OPENCLAW_CLAUDE_BRIDGE_CWD`.",
    };
  }

  const { claudeBin, allowedTools, timeoutMs, maxReplyChars } = resolveDefaults(config);

  const gatewayPassword = resolveGatewayPassword();
  const permHookScriptPath = gatewayPassword ? resolvePermHookScriptPath() : null;
  const permHookEnv = gatewayPassword
    ? buildPermHookEnv({
        gatewayUrl: resolveGatewayUrl(),
        gatewayPassword,
        routing: {
          channel: ctx.channel,
          chatId: stripChannelPrefix(ctx.channel, key),
          agentId: undefined,
          sessionKey: key,
          accountId: ctx.accountId,
          threadId: ctx.messageThreadId,
        },
      })
    : null;

  const result = await runClaude({
    bin: claudeBin,
    cwd: projectCwd,
    allowedTools,
    timeoutMs,
    prompt,
    resumeSessionId: null,
    permHookScriptPath,
    permHookEnv,
  });

  updateChatStateAfterTurn(key, result.newSessionId);

  return { text: truncate(result.text, maxReplyChars) };
}

function stripChannelPrefix(channel: string, key: string): string {
  const prefix = `${channel}:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function resolveChatKey(ctx: PluginCommandContext): string | undefined {
  // For telegram, `ctx.to` is `${channel}:${chatId}` (see
  // extensions/telegram/src/bot-native-commands.ts), which matches the shape
  // produced by chatStateKey() on the fallthrough side. Fall back to the
  // sender id if the channel adapter ever omits `to` so /claude is still
  // usable, even though state may not align with the fallthrough handler's
  // keyspace in that case.
  return ctx.to ?? ctx.from ?? ctx.senderId;
}

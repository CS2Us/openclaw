import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  adoptChatStateSession,
  getOrCreateChatState,
  resetChatState,
  updateChatStateAfterTurn,
} from "./chat-state.js";
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
import { findMostRecentSession } from "./session-discovery.js";

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

  const args = ctx.args?.trim() ?? "";
  const [first] = args.split(/\s+/);

  // Sub-commands `/claude session` and `/claude continue` operate on chat
  // state without resetting; both expose the bridge↔local-CLI session bridge.
  if (first === "session") {
    return handleSessionInfo(key);
  }
  if (first === "continue") {
    return handleContinue(key, config);
  }

  // §3.2 trigger table: `/claude` (no args) and `/claude <text>` both reset.
  // With no args we just reply "session reset"; with args we additionally
  // spawn a fresh claude turn (no --resume) so the args become the first
  // message of the new session.
  resetChatState(key);

  const prompt = args;
  if (!prompt) {
    return {
      text:
        "新会话已开启。直接给 bot 发消息即可继续，无需每次都打 /claude。\n" +
        "再次发送 /claude 会重置会话。\n\n" +
        "其他子命令：\n" +
        "  /claude session  — 显示当前 session id（本地可用 `claude --resume <id>` 接续）\n" +
        "  /claude continue — 接续 cwd 里最近的本地 claude session",
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

function handleSessionInfo(key: string): PluginCommandResult {
  const state = getOrCreateChatState(key);
  if (!state.sessionId) {
    return {
      text: "当前 chat 还没有活跃 claude session。直接发消息或 `/claude continue` 接续本地 session 即可。",
    };
  }
  return {
    text:
      `当前 session: \`${state.sessionId}\`\n` +
      `本地继续：\`claude --resume ${state.sessionId}\`（在 OPENCLAW_CLAUDE_BRIDGE_CWD 内跑）`,
  };
}

function handleContinue(key: string, config: ClaudeBridgeConfig): PluginCommandResult {
  const projectCwd = resolveProjectCwd(config);
  if (!projectCwd) {
    return {
      text:
        "claude-bridge: projectCwd is not configured.\n" +
        "Set it via plugin config (`projectCwd`) or env `OPENCLAW_CLAUDE_BRIDGE_CWD`.",
    };
  }
  const state = getOrCreateChatState(key);
  const exclude = new Set<string>();
  if (state.sessionId) {
    exclude.add(state.sessionId);
  }
  const recent = findMostRecentSession({ cwd: projectCwd, excludeSessionIds: exclude });
  if (!recent) {
    return {
      text:
        "本地 cwd 没有可接续的 claude session（或仅剩当前 chat 自己的）。\n" +
        "在终端里跑一次 `claude` 起一个，再回来 `/claude continue`。",
    };
  }
  adoptChatStateSession(key, recent.sessionId);
  const ageMin = Math.max(1, Math.round((Date.now() - recent.mtimeMs) / 60_000));
  const previewLine = recent.preview ? `\n最近用户消息：${recent.preview}` : "";
  return {
    text:
      `已接续本地最近 session：\`${recent.sessionId}\`\n` +
      `${recent.eventCount} 条事件，距今 ${ageMin} 分钟${previewLine}\n` +
      `下一条消息会接到这个 session 继续。`,
  };
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

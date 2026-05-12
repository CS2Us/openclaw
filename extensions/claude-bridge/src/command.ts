import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  adoptChatStateSession,
  clearActiveTab,
  createNewTab,
  getActiveTab,
  getOrCreateChatState,
  resetChatState,
  seedActiveTabLabel,
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
import { findMostRecentSession, listSessionFiles, readSessionInfo } from "./session-discovery.js";
import { type PanelEntry, renderPanel } from "./tab-manager-ui.js";

export function createClaudeCommand(options: {
  pluginConfig?: unknown;
}): OpenClawPluginCommandDefinition {
  return {
    name: "claude",
    description:
      "Open the tab manager. Plain DMs go to the active tab. Sub-commands: session / continue.",
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

  // Sub-commands operate on the active tab.
  if (first === "session") {
    return handleSessionInfo(key);
  }
  if (first === "continue") {
    return handleContinue(key, config);
  }
  if (first === "new") {
    return handleNewTab(key);
  }

  // `/claude` (no args): show the pool-driven panel — top-3 sessions by
  // jsonl mtime (across all claude session origins: IDE / CLI / overnight /
  // bot-spawned) + [+ 新 session] + numbered switch buttons. Excludes
  // policy-resolver arbitrator sessions (they pollute the pool — each tool
  // call leaves a tiny one-shot jsonl that would otherwise rank at top).
  //
  // **不进任何对话**：每次 /claude 清空 activeTabId。用户必须显式点 [N] 或
  // [+ 新 session] 才能开始对话——避免"我打开 panel 看一眼，结果发消息进了
  // 上次那条" 的隐式跳路由。
  if (!args) {
    clearActiveTab(key);
    const state = getOrCreateChatState(key);
    const cwd = resolveProjectCwd(config);
    const entries: PanelEntry[] = [];
    if (cwd) {
      const files = listSessionFiles(cwd);
      for (const f of files) {
        if (entries.length >= 3) break;
        const info = readSessionInfo(f.jsonlPath);
        // Skip arbitrator / agent-internal sessions whose only user prompt
        // is the policy-resolver evaluation harness.
        if (info.preview && info.preview.startsWith("判断以下 tool call")) {
          continue;
        }
        // Skip empty / aiTitle-only sessions (no real user prompt found).
        if (!info.preview) {
          continue;
        }
        entries.push({
          sessionId: f.sessionId,
          preview: info.preview,
          lastActivityMs: info.lastEventMs ?? f.mtimeMs,
        });
      }
    }
    const activeSessionId = getActiveTab(state)?.sessionId ?? null;
    const ui = renderPanel({ entries, activeSessionId });
    return { text: ui.text, interactive: ui.interactive };
  }

  // `/claude <text>`: send to active tab, auto-creating one if none exists.
  // This replaces the v1 "reset + send first message" semantics; explicit
  // reset is now the [🗑 重置全部] button in the tab manager.
  const state = getOrCreateChatState(key);
  if (!getActiveTab(state)) {
    createNewTab(key);
  }
  return spawnClaudeForActiveTab({ key, prompt: args, config, ctx });
}

function handleNewTab(key: string): PluginCommandResult {
  const tab = createNewTab(key);
  return {
    text: `已起新 tab：**${tab.label}**。直接发消息开始对话；再发 /claude 可看 / 切换全部 tab。`,
  };
}

function handleSessionInfo(key: string): PluginCommandResult {
  const state = getOrCreateChatState(key);
  const active = getActiveTab(state);
  if (!active || !active.sessionId) {
    return {
      text: "当前活跃 tab 还没有 claude session。直接发消息或 `/claude continue` 接续本地 session 即可。",
    };
  }
  return {
    text:
      `活跃 tab：**${active.label}**\n` +
      `当前 session: \`${active.sessionId}\`\n` +
      `本地继续：\`claude --resume ${active.sessionId}\`（在 OPENCLAW_CLAUDE_BRIDGE_CWD 内跑）`,
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
  for (const t of state.tabs) {
    if (t.sessionId) {
      exclude.add(t.sessionId);
    }
  }
  const recent = findMostRecentSession({ cwd: projectCwd, excludeSessionIds: exclude });
  if (!recent) {
    return {
      text:
        "本地 cwd 没有可接续的 claude session（或都已被本 chat 的 tab 占用）。\n" +
        "在终端里跑一次 `claude` 起一个，再回来 `/claude continue`。",
    };
  }
  adoptChatStateSession(key, recent.sessionId);
  const ageMin = Math.max(1, Math.round((Date.now() - recent.mtimeMs) / 60_000));
  const previewLine = recent.preview ? `\n最近用户消息：${recent.preview}` : "";
  const active = getActiveTab(getOrCreateChatState(key));
  return {
    text:
      `活跃 tab **${active?.label ?? "?"}** 已接续本地最近 session：\`${recent.sessionId}\`\n` +
      `${recent.eventCount} 条事件，距今 ${ageMin} 分钟${previewLine}\n` +
      `下一条消息会接到这个 session 继续。`,
  };
}

async function spawnClaudeForActiveTab(params: {
  key: string;
  prompt: string;
  config: ClaudeBridgeConfig;
  ctx: PluginCommandContext;
}): Promise<PluginCommandResult> {
  const { key, prompt, config, ctx } = params;
  const projectCwd = resolveProjectCwd(config);
  if (!projectCwd) {
    return {
      text:
        "claude-bridge: projectCwd is not configured.\n" +
        "Set it via plugin config (`projectCwd`) or env `OPENCLAW_CLAUDE_BRIDGE_CWD`.",
    };
  }

  const { claudeBin, allowedTools, timeoutMs, maxReplyChars } = resolveDefaults(config);

  const state = getOrCreateChatState(key);
  // Lock the label at turn-start so back-to-back /claude commands don't race.
  seedActiveTabLabel(key, prompt);
  const active = getActiveTab(state);

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
    resumeSessionId: active?.sessionId ?? null,
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
  return ctx.to ?? ctx.from ?? ctx.senderId;
}

// Re-exports kept so other modules (tests, fallthrough handler) don't have to
// import side-effect symbols from chat-state directly.
export { resetChatState };

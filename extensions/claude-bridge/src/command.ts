import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  resolveDefaults,
  resolveProjectCwd,
  runClaudeOnce,
  truncate,
  type ClaudeBridgeConfig,
} from "./handler.js";

export function createClaudeCommand(options: {
  pluginConfig?: unknown;
}): OpenClawPluginCommandDefinition {
  return {
    name: "claude",
    description:
      "Run a task in local Claude Code (headless `claude -p`) and reply with the result. Plain DMs to this bot are also forwarded automatically; use this command to pass a one-off task explicitly.",
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
  const projectCwd = resolveProjectCwd(config);
  if (!projectCwd) {
    return {
      text:
        "claude-bridge: projectCwd is not configured.\n" +
        "Set it via plugin config (`projectCwd`) or env `OPENCLAW_CLAUDE_BRIDGE_CWD`.",
    };
  }

  const prompt = ctx.args?.trim() ?? "";
  if (!prompt) {
    return { text: "Usage: /claude <task description>" };
  }

  const { claudeBin, allowedTools, timeoutMs, maxReplyChars } = resolveDefaults(config);

  const result = await runClaudeOnce({
    bin: claudeBin,
    cwd: projectCwd,
    allowedTools,
    timeoutMs,
    prompt,
  });

  return { text: truncate(result.text, maxReplyChars) };
}

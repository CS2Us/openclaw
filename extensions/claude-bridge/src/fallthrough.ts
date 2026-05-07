import type {
  PluginInboundFallthroughEvent,
  PluginInboundFallthroughHandler,
  PluginInboundFallthroughResult,
} from "openclaw/plugin-sdk/plugin-runtime";
import {
  resolveDefaults,
  resolveProjectCwd,
  runClaudeOnce,
  truncate,
  type ClaudeBridgeConfig,
} from "./handler.js";

export function createClaudeBridgeFallthroughHandler(options: {
  pluginConfig?: unknown;
}): PluginInboundFallthroughHandler {
  return async (event: PluginInboundFallthroughEvent): Promise<PluginInboundFallthroughResult> => {
    const config = (options.pluginConfig ?? {}) as ClaudeBridgeConfig;
    const projectCwd = resolveProjectCwd(config);
    if (!projectCwd) {
      return {
        handled: true,
        reply:
          "claude-bridge: projectCwd is not configured.\n" +
          "Set it via plugin config (`projectCwd`) or env `OPENCLAW_CLAUDE_BRIDGE_CWD`.",
      };
    }

    const { claudeBin, allowedTools, timeoutMs, maxReplyChars } = resolveDefaults(config);
    const prompt = event.text.trim();
    if (!prompt) {
      return { handled: false };
    }

    const result = await runClaudeOnce({
      bin: claudeBin,
      cwd: projectCwd,
      allowedTools,
      timeoutMs,
      prompt,
    });

    return { handled: true, reply: truncate(result.text, maxReplyChars) };
  };
}

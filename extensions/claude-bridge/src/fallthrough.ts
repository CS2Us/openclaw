import type {
  PluginInboundFallthroughEvent,
  PluginInboundFallthroughHandler,
  PluginInboundFallthroughResult,
} from "openclaw/plugin-sdk/plugin-runtime";
import { chatStateKey, getOrCreateChatState, updateChatStateAfterTurn } from "./chat-state.js";
import {
  resolveDefaults,
  resolveProjectCwd,
  runClaude,
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

    const key = chatStateKey(event.channel, event.chatId);
    const state = getOrCreateChatState(key);

    const result = await runClaude({
      bin: claudeBin,
      cwd: projectCwd,
      allowedTools,
      timeoutMs,
      prompt,
      resumeSessionId: state.sessionId,
    });

    updateChatStateAfterTurn(key, result.newSessionId);

    return { handled: true, reply: truncate(result.text, maxReplyChars) };
  };
}

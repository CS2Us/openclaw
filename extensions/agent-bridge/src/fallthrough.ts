import type {
  PluginInboundFallthroughEvent,
  PluginInboundFallthroughHandler,
  PluginInboundFallthroughResult,
} from "openclaw/plugin-sdk/plugin-runtime";
import {
  chatStateKey,
  getActiveTab,
  getOrCreateChatState,
  seedActiveTabLabel,
  updateChatStateAfterTurn,
} from "./chat-state.js";
import { writeFollowMarker } from "./follow-marker.js";
import {
  resolveDefaults,
  resolveProjectCwd,
  runAgent,
  truncate,
  type AgentBridgeConfig,
} from "./handler.js";
import {
  buildPermHookEnv,
  resolveGatewayPassword,
  resolveGatewayUrl,
  resolvePermHookScriptPath,
} from "./perm-hook-spawn.js";

export function createAgentBridgeFallthroughHandler(options: {
  pluginConfig?: unknown;
}): PluginInboundFallthroughHandler {
  return async (event: PluginInboundFallthroughEvent): Promise<PluginInboundFallthroughResult> => {
    const config = (options.pluginConfig ?? {}) as AgentBridgeConfig;
    const projectCwd = resolveProjectCwd(config);
    if (!projectCwd) {
      return {
        handled: true,
        reply:
          "agent-bridge: projectCwd is not configured.\n" +
          "Set it via plugin config (`projectCwd`) or env `OPENCLAW_AGENT_BRIDGE_CWD`.",
      };
    }

    const {
      agentBin,
      provider,
      model,
      reasoningEffort,
      capabilityMode,
      allowedTools,
      timeoutMs,
      maxReplyChars,
    } = resolveDefaults(config);
    const prompt = event.text.trim();
    if (!prompt) {
      return { handled: false };
    }

    const key = chatStateKey(event.channel, event.chatId);
    const state = getOrCreateChatState(key);

    // Strict routing (2026-05-12): plain DM only routes when the user has
    // *explicitly* entered a session — via `/agent` panel ([N] / [+ 新 session])
    // or the approval-nudge `[👁 进入]` button. Daemon restart no longer
    // restores the previous active tab (see chat-state.fromPersisted). If no
    // active tab, refuse to route and prompt the user to pick.
    //
    // Rationale: user opens Telegram fresh and types something — without
    // this check the message silently lands in whatever session was active
    // before the restart, which is surprising / can leak between contexts.
    if (!getActiveTab(state)) {
      return {
        handled: true,
        reply:
          "📌 还没选中 session。先发 /agent 看面板：\n" +
          "  • 点 `[N]` 切到最近的某条 session\n" +
          "  • 或 `[+ 新 session]` 开新对话\n" +
          "选好之后，plain DM 都路由到那条 session。",
      };
    }
    // Lock the label to *this* prompt before claude even spawns — turn-start
    // ordering wins so two rapid messages don't fight over the label at
    // turn-end (whichever claude turn returns first would otherwise win).
    seedActiveTabLabel(key, prompt);
    const active = getActiveTab(state);

    const interactiveClaude = provider === "claude" && capabilityMode === "interactive";
    const sessionProvider = active?.provider ?? (active?.sessionId ? "claude" : undefined);
    const mayResume = interactiveClaude && (!sessionProvider || sessionProvider === provider);
    const gatewayPassword = interactiveClaude ? resolveGatewayPassword() : null;
    const permHookScriptPath = gatewayPassword ? resolvePermHookScriptPath() : null;
    const permHookEnv = gatewayPassword
      ? buildPermHookEnv({
          gatewayUrl: resolveGatewayUrl(),
          gatewayPassword,
          routing: {
            channel: event.channel,
            chatId: event.chatId,
            agentId: event.agentId,
            sessionKey: event.sessionKey ?? key,
            accountId: event.accountId,
            threadId: event.threadId,
          },
        })
      : null;

    // Plain DM means "I'm engaged with this session right now" — write the
    // follow marker proactively so perm-hook.cjs skips the `[👁 进入]` nudge
    // (the user is already in the session by typing into it). The mid-call
    // write is fine: claude is about to spawn → tool call → perm-hook → poll
    // marker, all within a few seconds. updateChatStateAfterTurn below may
    // rewrite active.sessionId if claude started a fresh session id; we also
    // mirror that into the marker (the post-turn write is cheap and idempotent).
    if (active?.sessionId) {
      writeFollowMarker(event.chatId, active.sessionId);
    }

    const result = await runAgent({
      bin: agentBin,
      provider,
      model,
      reasoningEffort,
      cwd: projectCwd,
      allowedTools,
      timeoutMs,
      prompt,
      resumeSessionId: mayResume ? (active?.sessionId ?? null) : null,
      permHookScriptPath,
      permHookEnv,
    });

    updateChatStateAfterTurn(key, interactiveClaude ? result.newSessionId : null, provider);
    if (result.newSessionId) {
      writeFollowMarker(event.chatId, result.newSessionId);
    }

    return { handled: true, reply: truncate(result.text, maxReplyChars) };
  };
}

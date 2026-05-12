import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { setClaudeBridgeRuntime } from "./src/chat-state-store.js";
import { hydrateChatStatesFromStore } from "./src/chat-state.js";
import { createClaudeCommand } from "./src/command.js";
import { getDaemonGatewayClient } from "./src/daemon-gateway-client.js";
import { createClaudeBridgeFallthroughHandler } from "./src/fallthrough.js";
import { notifyAndClearStaleFollowMarkers } from "./src/follow-marker.js";
import { createTabManagerInteractiveHandler } from "./src/interactive.js";

export default definePluginEntry({
  id: "claude-bridge",
  name: "Claude Bridge",
  description:
    "Forward Telegram DMs (and explicit /claude commands) to local Claude Code (`claude -p`).",
  register(api) {
    setClaudeBridgeRuntime(api.runtime);
    // Hydrate persisted per-chat sessionIds so the very first DM after a
    // daemon restart still spawns claude with `--resume <prior>`. Fire-and-
    // forget: in-memory chat-state remains correct (just empty) until this
    // resolves, and the keyed-store layer is best-effort.
    void hydrateChatStatesFromStore().catch(() => {
      // chat-state-store already logs the underlying failure and disables
      // itself; nothing to do here.
    });

    api.registerCommand(createClaudeCommand({ pluginConfig: api.pluginConfig }));
    api.registerInboundFallthroughHandler({
      channel: "telegram",
      handler: createClaudeBridgeFallthroughHandler({ pluginConfig: api.pluginConfig }),
    });
    api.registerInteractiveHandler(
      createTabManagerInteractiveHandler({ pluginConfig: api.pluginConfig }),
    );
    // Eagerly establish the loopback WS connection so the `operator.approvals`
    // scope is registered before any perm-hook fires a plugin.approval.request.
    // Without this, openclaw treats the approval as routeless and auto-expires
    // (decision=null → perm-hook emits deny instantly). See
    // src/daemon-gateway-client.ts comment for full reasoning.
    getDaemonGatewayClient()?.connectEagerly();

    // Stale follow markers left over from a previous daemon process: notify
    // each affected chat that its stream stopped, then delete the marker so
    // perm-hook is back to "no-follow" state. Best-effort.
    void notifyAndClearStaleFollowMarkers({
      tgBotToken: process.env.TG_BOT_TOKEN,
    }).catch(() => {});
  },
});

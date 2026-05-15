import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { setChromiteBridgeRuntime } from "./src/chat-state-store.js";
import { hydrateChatStatesFromStore } from "./src/chat-state.js";
import { createChromiteCommand } from "./src/command.js";
import { createConfirmCommand } from "./src/confirm-command.js";
import { createChromiteBridgeFallthroughHandler } from "./src/fallthrough.js";

export default definePluginEntry({
  id: "chromite-bridge",
  name: "Chromite Bridge",
  description:
    "Forward Telegram DMs (and /chromite commands) to local chromite-server /v1/chat/stream.",
  register(api) {
    setChromiteBridgeRuntime(api.runtime);
    // Hydrate persisted per-chat session_ids so first DM after daemon restart
    // reuses the same chromite session. Fire-and-forget: in-memory chat-state
    // remains correct (empty) until this resolves, and the keyed-store layer
    // is best-effort.
    void hydrateChatStatesFromStore().catch(() => {
      // chat-state-store already logs the underlying failure and disables
      // itself; nothing to do here.
    });

    api.registerCommand(createChromiteCommand({ pluginConfig: api.pluginConfig }));
    api.registerCommand(createConfirmCommand({ pluginConfig: api.pluginConfig }));
    api.registerInboundFallthroughHandler({
      channel: "telegram",
      handler: createChromiteBridgeFallthroughHandler({
        pluginConfig: api.pluginConfig,
      }),
    });
  },
});

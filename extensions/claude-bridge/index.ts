import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { setClaudeBridgeRuntime } from "./src/chat-state-store.js";
import { hydrateChatStatesFromStore } from "./src/chat-state.js";
import { createClaudeCommand } from "./src/command.js";
import { createClaudeBridgeFallthroughHandler } from "./src/fallthrough.js";
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
  },
});

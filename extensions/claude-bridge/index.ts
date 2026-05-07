import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createClaudeCommand } from "./src/command.js";
import { createClaudeBridgeFallthroughHandler } from "./src/fallthrough.js";

export default definePluginEntry({
  id: "claude-bridge",
  name: "Claude Bridge",
  description:
    "Forward Telegram DMs (and explicit /claude commands) to local Claude Code (`claude -p`).",
  register(api) {
    api.registerCommand(createClaudeCommand({ pluginConfig: api.pluginConfig }));
    api.registerInboundFallthroughHandler({
      channel: "telegram",
      handler: createClaudeBridgeFallthroughHandler({ pluginConfig: api.pluginConfig }),
    });
  },
});

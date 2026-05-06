import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createClaudeCommand } from "./src/command.js";

export default definePluginEntry({
  id: "claude-bridge",
  name: "Claude Bridge",
  description: "Forward /claude commands to local Claude Code headless.",
  register(api) {
    api.registerCommand(createClaudeCommand({ pluginConfig: api.pluginConfig }));
  },
});

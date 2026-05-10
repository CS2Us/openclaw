import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createOvernightCommand,
  createOvernightStatusCommand,
  createOvernightStopCommand,
} from "./src/commands.js";

export default definePluginEntry({
  id: "claude-overnight",
  name: "Claude Overnight",
  description:
    "Run local Claude Code unattended overnight; auto-resume across 5h rate-limit windows.",
  register(api) {
    api.registerCommand(createOvernightCommand({ pluginConfig: api.pluginConfig }));
    api.registerCommand(createOvernightStatusCommand({ pluginConfig: api.pluginConfig }));
    api.registerCommand(createOvernightStopCommand({ pluginConfig: api.pluginConfig }));
  },
});

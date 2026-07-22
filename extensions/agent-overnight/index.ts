import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createOvernightCommand,
  createOvernightStatusCommand,
  createOvernightStopCommand,
} from "./src/commands.js";

export default definePluginEntry({
  id: "agent-overnight",
  name: "Agent Overnight",
  description: "Run a capability-gated local provider unattended with auto-resume.",
  register(api) {
    api.registerCommand(createOvernightCommand({ pluginConfig: api.pluginConfig }));
    api.registerCommand(createOvernightStatusCommand({ pluginConfig: api.pluginConfig }));
    api.registerCommand(createOvernightStopCommand({ pluginConfig: api.pluginConfig }));
  },
});

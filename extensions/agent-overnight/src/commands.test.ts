import { describe, expect, it } from "vitest";
import { resolveOvernightCapabilityError, resolveOvernightDefaults } from "./commands.js";

describe("agent-overnight capability gate", () => {
  it("keeps the verified Claude resume + allow-list path available", () => {
    expect(resolveOvernightCapabilityError({ provider: "claude" })).toBeNull();
    expect(resolveOvernightCapabilityError({})).toBeNull();
  });

  it("fails closed before spawn for providers without unattended capabilities", () => {
    expect(resolveOvernightCapabilityError({ provider: "codex" })).toContain(
      "resume, unattended_allowlist",
    );
    expect(resolveOvernightCapabilityError({ provider: "gemini" })).toContain(
      "resume, unattended_allowlist",
    );
  });
});

describe("agent-overnight provider binary resolution", () => {
  it("uses the launcher-resolved provider binary in strict daemon mode", () => {
    expect(
      resolveOvernightDefaults(
        { provider: "claude" },
        {
          OPENCLAW_AGENT_BRIDGE_BIN_RESOLUTION: "strict",
          OPENCLAW_AGENT_BRIDGE_CLAUDE_BIN: "/launcher/claude",
        },
      ).agentBin,
    ).toBe("/launcher/claude");
  });

  it("keeps an explicit absolute operator override ahead of launcher discovery", () => {
    expect(
      resolveOvernightDefaults(
        { provider: "claude", agentBin: "/operator/claude" },
        {
          OPENCLAW_AGENT_BRIDGE_BIN_RESOLUTION: "strict",
          OPENCLAW_AGENT_BRIDGE_CLAUDE_BIN: "/launcher/claude",
        },
      ).agentBin,
    ).toBe("/operator/claude");
  });

  it("rejects PATH-based or missing binaries before detached supervisor spawn", () => {
    expect(() =>
      resolveOvernightDefaults(
        { provider: "claude", agentBin: "claude" },
        {
          OPENCLAW_AGENT_BRIDGE_BIN_RESOLUTION: "strict",
          OPENCLAW_AGENT_BRIDGE_CLAUDE_BIN: "/launcher/claude",
        },
      ),
    ).toThrow("selected provider claude CLI requires an absolute path");

    expect(() =>
      resolveOvernightDefaults(
        { provider: "claude" },
        { OPENCLAW_AGENT_BRIDGE_BIN_RESOLUTION: "strict" },
      ),
    ).toThrow("selected provider claude CLI requires an absolute path");
  });
});

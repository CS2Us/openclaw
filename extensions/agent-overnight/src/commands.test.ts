import { describe, expect, it } from "vitest";
import { resolveOvernightCapabilityError } from "./commands.js";

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

import { describe, expect, it } from "vitest";
import {
  buildPluginApprovalRequestParams,
  formatToolDescription,
  mapOpenclawDecisionToClaude,
} from "./perm-hook-decision.js";

describe("mapOpenclawDecisionToClaude", () => {
  it("maps allow-once → allow with this-turn reason", () => {
    expect(mapOpenclawDecisionToClaude("allow-once")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "approved by user (this turn)",
      },
    });
  });

  it("maps allow-always → allow with always reason", () => {
    expect(mapOpenclawDecisionToClaude("allow-always").hookSpecificOutput.permissionDecision).toBe(
      "allow",
    );
    expect(
      mapOpenclawDecisionToClaude("allow-always").hookSpecificOutput.permissionDecisionReason,
    ).toBe("approved by user (always)");
  });

  it("maps deny → deny with denied reason", () => {
    expect(mapOpenclawDecisionToClaude("deny")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "denied by user",
      },
    });
  });

  it("maps null → deny (timeout fallback)", () => {
    expect(mapOpenclawDecisionToClaude(null).hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "approval timed out or unavailable",
    });
  });

  it("maps undefined → deny (timeout fallback)", () => {
    expect(mapOpenclawDecisionToClaude(undefined).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    );
  });
});

describe("formatToolDescription", () => {
  it("joins tool name + JSON-serialized input", () => {
    expect(formatToolDescription("Read", { file_path: "/etc/passwd" })).toBe(
      'Tool: Read\n{"file_path":"/etc/passwd"}',
    );
  });

  it("truncates long inputs at 200 chars with ellipsis", () => {
    const longInput = { data: "x".repeat(500) };
    const desc = formatToolDescription("LongTool", longInput);
    expect(desc.startsWith("Tool: LongTool\n")).toBe(true);
    expect(desc).toMatch(/…$/);
    expect(desc.length).toBeLessThanOrEqual("Tool: LongTool\n".length + 201);
  });

  it("omits input line when input is null/undefined", () => {
    expect(formatToolDescription("Bash", undefined)).toBe("Tool: Bash");
    expect(formatToolDescription("Bash", null)).toBe("Tool: Bash");
  });

  it("falls back to '?' when toolName missing", () => {
    expect(formatToolDescription(undefined, {})).toBe("Tool: ?\n{}");
  });
});

describe("buildPluginApprovalRequestParams", () => {
  const baseEnv: NodeJS.ProcessEnv = {
    OPENCLAW_TURN_AGENT_ID: "agent-1",
    OPENCLAW_TURN_SESSION_KEY: "telegram:12345",
    OPENCLAW_TURN_SOURCE_CHANNEL: "telegram",
    OPENCLAW_TURN_SOURCE_TO: "12345",
    OPENCLAW_TURN_SOURCE_ACCOUNT_ID: "default",
  };

  it("produces a payload that matches plugin.approval.request schema", () => {
    const params = buildPluginApprovalRequestParams({
      toolName: "Bash",
      toolInput: { command: "rm -rf /tmp/x" },
      toolUseId: "toolu_123",
      env: baseEnv,
      approvalTimeoutMs: 110_000,
    });
    expect(params).toMatchObject({
      pluginId: "agent-bridge",
      title: "Bash",
      severity: "warning",
      toolName: "Bash",
      toolCallId: "toolu_123",
      agentId: "agent-1",
      sessionKey: "telegram:12345",
      turnSourceChannel: "telegram",
      turnSourceTo: "12345",
      turnSourceAccountId: "default",
      timeoutMs: 110_000,
      twoPhase: true,
    });
    expect("turnSourceThreadId" in params).toBe(false);
  });

  it("encodes numeric thread ids as numbers", () => {
    const params = buildPluginApprovalRequestParams({
      toolName: "Read",
      toolInput: {},
      toolUseId: undefined,
      env: { ...baseEnv, OPENCLAW_TURN_SOURCE_THREAD_ID: "77" },
      approvalTimeoutMs: 110_000,
    });
    expect(params.turnSourceThreadId).toBe(77);
  });

  it("keeps non-numeric thread ids as strings", () => {
    const params = buildPluginApprovalRequestParams({
      toolName: "Read",
      toolInput: {},
      toolUseId: undefined,
      env: { ...baseEnv, OPENCLAW_TURN_SOURCE_THREAD_ID: "topic-abc" },
      approvalTimeoutMs: 110_000,
    });
    expect(params.turnSourceThreadId).toBe("topic-abc");
  });

  it("omits thread id when env value is empty/missing", () => {
    const empty = buildPluginApprovalRequestParams({
      toolName: "Read",
      toolInput: {},
      toolUseId: undefined,
      env: { ...baseEnv, OPENCLAW_TURN_SOURCE_THREAD_ID: "" },
      approvalTimeoutMs: 110_000,
    });
    expect("turnSourceThreadId" in empty).toBe(false);
  });

  it("falls back to defaults when routing env vars missing", () => {
    const params = buildPluginApprovalRequestParams({
      toolName: "Read",
      toolInput: {},
      toolUseId: undefined,
      env: {},
      approvalTimeoutMs: 110_000,
    });
    expect(params).toMatchObject({
      agentId: "agent-bridge",
      sessionKey: "agent-bridge-session",
      turnSourceChannel: "telegram",
      turnSourceTo: "0",
      turnSourceAccountId: "default",
    });
  });
});

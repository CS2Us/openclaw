// Pure helpers for the claude PreToolUse hook. Kept in TS so we get
// strict-typed unit coverage; the hook script (`scripts/perm-hook.cjs`)
// inlines a CJS copy of `mapOpenclawDecisionToClaude` and `truncateForGateway`
// because it must run as a plain Node subprocess without TS compilation.
// If you change one, change the other.

export type OpenclawDecision = "allow-once" | "allow-always" | "deny" | null | undefined;

export type ClaudePreToolUseDecision = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny" | "ask";
    permissionDecisionReason: string;
  };
};

export function mapOpenclawDecisionToClaude(decision: OpenclawDecision): ClaudePreToolUseDecision {
  if (decision === "allow-once") {
    return claudeDecision("allow", "approved by user (this turn)");
  }
  if (decision === "allow-always") {
    return claudeDecision("allow", "approved by user (always)");
  }
  if (decision === "deny") {
    return claudeDecision("deny", "denied by user");
  }
  return claudeDecision("deny", "approval timed out or unavailable");
}

export function buildPluginApprovalRequestParams(input: {
  toolName: string | undefined;
  toolInput: unknown;
  toolUseId: string | undefined;
  env: NodeJS.ProcessEnv;
  approvalTimeoutMs: number;
}) {
  const env = input.env;
  const description = formatToolDescription(input.toolName, input.toolInput);
  const params: Record<string, unknown> = {
    pluginId: "agent-bridge",
    title: input.toolName ?? "tool",
    description,
    severity: "warning",
    toolName: input.toolName ?? "unknown",
    toolCallId: input.toolUseId,
    agentId: env.OPENCLAW_TURN_AGENT_ID || "agent-bridge",
    sessionKey: env.OPENCLAW_TURN_SESSION_KEY || "agent-bridge-session",
    turnSourceChannel: env.OPENCLAW_TURN_SOURCE_CHANNEL || "telegram",
    turnSourceTo: env.OPENCLAW_TURN_SOURCE_TO || "0",
    turnSourceAccountId: env.OPENCLAW_TURN_SOURCE_ACCOUNT_ID || "default",
    timeoutMs: input.approvalTimeoutMs,
    twoPhase: true,
  };
  // threadId schema is string|number; DM has no thread → omit field.
  const rawTid = env.OPENCLAW_TURN_SOURCE_THREAD_ID;
  if (rawTid && rawTid.length > 0) {
    const numericPattern = /^-?\d+$/;
    params.turnSourceThreadId = numericPattern.test(rawTid) ? Number(rawTid) : rawTid;
  }
  return params;
}

export function formatToolDescription(toolName: string | undefined, toolInput: unknown): string {
  const lines = [`Tool: ${toolName ?? "?"}`];
  if (toolInput !== undefined && toolInput !== null) {
    const json = safeJsonStringify(toolInput);
    if (json.length > 0) {
      lines.push(json.length > 200 ? `${json.slice(0, 200)}…` : json);
    }
  }
  return lines.join("\n");
}

function claudeDecision(
  decision: ClaudePreToolUseDecision["hookSpecificOutput"]["permissionDecision"],
  reason: string,
): ClaudePreToolUseDecision {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

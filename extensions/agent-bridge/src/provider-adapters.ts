export type AgentProviderId = "claude" | "codex" | "gemini";
export type AgentCapability =
  | "one_shot"
  | "resume"
  | "stream_events"
  | "tool_approval"
  | "unattended_allowlist";

export type ProviderSpawnRequest = {
  provider: AgentProviderId;
  prompt: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  allowedTools: string;
  resumeSessionId?: string | null;
  permHookScriptPath?: string | null;
};

export type ProviderSpawnSpec = {
  args: string[];
  stdin: string | null;
  output: "claude-stream-json" | "codex-jsonl" | "text";
  capabilities: ReadonlySet<AgentCapability>;
};

const CAPABILITIES: Record<AgentProviderId, ReadonlySet<AgentCapability>> = {
  claude: new Set(["one_shot", "resume", "stream_events", "tool_approval", "unattended_allowlist"]),
  codex: new Set(["one_shot"]),
  gemini: new Set(["one_shot"]),
};

export class AgentCapabilityError extends Error {
  readonly code = "AGENT_CAPABILITY_UNAVAILABLE";

  constructor(
    readonly provider: AgentProviderId,
    readonly capability: AgentCapability,
  ) {
    super(`agent provider ${provider} does not support required capability: ${capability}`);
  }
}

export function providerCapabilities(provider: AgentProviderId): ReadonlySet<AgentCapability> {
  return CAPABILITIES[provider];
}

function requireCapability(provider: AgentProviderId, capability: AgentCapability): void {
  if (!CAPABILITIES[provider].has(capability)) {
    throw new AgentCapabilityError(provider, capability);
  }
}

export function buildProviderSpawnSpec(request: ProviderSpawnRequest): ProviderSpawnSpec {
  const { provider } = request;
  requireCapability(provider, "one_shot");
  if (request.resumeSessionId) {
    requireCapability(provider, "resume");
  }
  if (request.permHookScriptPath) {
    requireCapability(provider, "tool_approval");
  }

  if (provider === "claude") {
    const args = [
      "-p",
      request.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowed-tools",
      request.allowedTools,
    ];
    const permissionMode =
      process.env.OPENCLAW_AGENT_BRIDGE_PERMISSION_MODE?.trim() ||
      process.env.CLAUDE_BRIDGE_PERMISSION_MODE?.trim();
    if (permissionMode) {
      args.push("--permission-mode", permissionMode);
    }
    if (request.model) {
      args.push("--model", request.model);
    }
    if (request.resumeSessionId) {
      args.push("--resume", request.resumeSessionId);
    }
    if (request.permHookScriptPath) {
      const settings = JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [{ type: "command", command: request.permHookScriptPath }],
            },
          ],
        },
      });
      args.push("--settings", settings, "--include-hook-events");
    }
    return { args, stdin: null, output: "claude-stream-json", capabilities: CAPABILITIES.claude };
  }

  if (provider === "codex") {
    const args = ["exec"];
    if (request.model) {
      args.push("--model", request.model);
    }
    args.push(
      "-c",
      `model_reasoning_effort="${request.reasoningEffort ?? "high"}"`,
      "--sandbox",
      "read-only",
      "--json",
      "-",
    );
    return { args, stdin: request.prompt, output: "codex-jsonl", capabilities: CAPABILITIES.codex };
  }

  const args = [
    "--model",
    request.model ?? "gemini-3.5-flash-high",
    "--effort",
    request.reasoningEffort ?? "high",
    "--print",
    request.prompt,
  ];
  return { args, stdin: null, output: "text", capabilities: CAPABILITIES.gemini };
}

export function parseCodexJsonl(text: string): { text: string; sessionId: string | null } {
  let sessionId: string | null = null;
  const messages: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(event)) {
      continue;
    }
    const threadId = event["thread_id"];
    if (!sessionId && typeof threadId === "string") {
      sessionId = threadId;
    }
    if (event["type"] !== "item.completed" || !isObject(event["item"])) {
      continue;
    }
    const item = event["item"];
    if (item["type"] === "agent_message" && typeof item["text"] === "string") {
      messages.push(item["text"]);
    }
  }
  return { text: messages.join(""), sessionId };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

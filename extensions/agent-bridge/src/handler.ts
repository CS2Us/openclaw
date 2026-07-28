// Spawn the explicitly configured provider for one turn. Provider-specific
// argv, output parsing, resume, and approval semantics stay in adapters.

import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import {
  buildProviderSpawnSpec,
  parseCodexJsonl,
  type AgentProviderId,
} from "./provider-adapters.js";

export type AgentBridgeConfig = {
  projectCwd?: string;
  agentBin?: string;
  provider?: AgentProviderId;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  capabilityMode?: "interactive" | "one-shot";
  allowedTools?: string;
  timeoutMs?: number;
  maxReplyChars?: number;
};

const DEFAULTS = {
  agentBin: "agent",
  provider: "claude" as AgentProviderId,
  allowedTools: "Read,Edit,Bash(git:*,cargo:*,ls,cat),Grep,Glob",
  timeoutMs: 300_000,
  maxReplyChars: 3_500,
} as const;

const PROVIDER_BIN_ENV: Record<AgentProviderId, string> = {
  claude: "OPENCLAW_AGENT_BRIDGE_CLAUDE_BIN",
  codex: "OPENCLAW_AGENT_BRIDGE_CODEX_BIN",
  gemini: "OPENCLAW_AGENT_BRIDGE_GEMINI_BIN",
};

const PROVIDER_BIN_NAME: Record<AgentProviderId, string> = {
  claude: DEFAULTS.agentBin,
  codex: "codex",
  gemini: "agy",
};

export type RunClaudeResult = {
  text: string;
  newSessionId: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
};

export function resolveProjectCwd(config: AgentBridgeConfig): string | undefined {
  // Env var wins so config can stay machine-portable (committable).
  const fromEnv =
    process.env.OPENCLAW_AGENT_BRIDGE_CWD?.trim() || process.env.OPENCLAW_CLAUDE_BRIDGE_CWD?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const fromConfig = config.projectCwd?.trim();
  return fromConfig || undefined;
}

export type RunClaudeParams = {
  bin: string;
  provider?: AgentProviderId;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  cwd: string;
  allowedTools: string;
  timeoutMs: number;
  prompt: string;
  /** When provided, spawn with `--resume <sessionId>` to continue an existing session. */
  resumeSessionId?: string | null;
  /**
   * Absolute path to the PreToolUse hook script. When set, claude is launched
   * with `--settings` carrying a hook config that delegates every tool call to
   * this script (see scripts/perm-hook.cjs). The hook reads gateway routing
   * info from `permHookEnv` to forward decisions to openclaw approval pipeline.
   */
  permHookScriptPath?: string | null;
  permHookEnv?: Record<string, string> | null;
};

export function buildClaudeSpawnArgs(params: RunClaudeParams): string[] {
  return buildProviderSpawnSpec({ ...params, provider: "claude" }).args;
}

export function buildClaudeSpawnEnv(
  params: Pick<RunClaudeParams, "permHookEnv">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!params.permHookEnv) {
    return baseEnv;
  }
  return { ...baseEnv, ...params.permHookEnv };
}

export function runAgent(params: RunClaudeParams): Promise<RunClaudeResult> {
  return new Promise((resolve, reject) => {
    const provider = params.provider ?? "claude";
    const spec = buildProviderSpawnSpec({
      provider,
      prompt: params.prompt,
      model: params.model,
      reasoningEffort: params.reasoningEffort,
      allowedTools: params.allowedTools,
      resumeSessionId: params.resumeSessionId,
      permHookScriptPath: params.permHookScriptPath,
    });
    const env = buildClaudeSpawnEnv(params);

    const child = spawn(params.bin, spec.args, {
      cwd: params.cwd,
      env,
      stdio: [spec.stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const childStdin = child.stdin;
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (!childStdout || !childStderr || (spec.stdin !== null && !childStdin)) {
      child.kill();
      reject(new Error("agent-bridge: provider process streams are unavailable"));
      return;
    }
    if (spec.stdin !== null) {
      childStdin?.end(spec.stdin);
    }

    const aggregator = createStreamJsonAggregator();
    let stdoutBuffer = "";
    let stderr = "";
    let timedOut = false;

    childStdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      if (spec.output !== "claude-stream-json") {
        return;
      }
      let newlineIdx = stdoutBuffer.indexOf("\n");
      while (newlineIdx >= 0) {
        const line = stdoutBuffer.slice(0, newlineIdx);
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        aggregator.feedLine(line);
        newlineIdx = stdoutBuffer.indexOf("\n");
      }
    });
    childStderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, params.timeoutMs);
    killer.unref();

    child.on("error", (err) => {
      clearTimeout(killer);
      reject(err);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(killer);
      // Flush any unterminated trailing line.
      if (spec.output === "claude-stream-json" && stdoutBuffer.length > 0) {
        aggregator.feedLine(stdoutBuffer);
        stdoutBuffer = "";
      }
      const aggregated =
        spec.output === "claude-stream-json"
          ? aggregator.finalize()
          : spec.output === "codex-jsonl"
            ? parseCodexJsonl(stdoutBuffer)
            : { text: stdoutBuffer, sessionId: null };
      const text = formatReply({
        provider,
        aggregatedText: aggregated.text,
        stderr,
        exitCode,
        signal,
        timedOut,
      });
      resolve({
        text,
        newSessionId: aggregated.sessionId,
        exitCode,
        signal,
        timedOut,
      });
    });
  });
}

function formatReply(r: {
  provider: AgentProviderId;
  aggregatedText: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}): string {
  if (r.timedOut) {
    return `agent-bridge: timed out\n---\n${r.aggregatedText || r.stderr}`.trim();
  }
  if (r.exitCode === 0) {
    return r.aggregatedText.trim() || `(${r.provider} returned no output)`;
  }
  return `agent-bridge: exit ${r.exitCode}${r.signal ? ` (${r.signal})` : ""}\n---\n${r.stderr || r.aggregatedText}`.trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n\n…(truncated, ${text.length - max} chars dropped)`;
}

export function resolveDefaults(config: AgentBridgeConfig, env: NodeJS.ProcessEnv = process.env) {
  const provider = config.provider ?? DEFAULTS.provider;
  const launcherBin = env[PROVIDER_BIN_ENV[provider]]?.trim();
  const configuredBin = config.agentBin?.trim();
  if (env.OPENCLAW_AGENT_BRIDGE_BIN_RESOLUTION === "strict") {
    const selectedBin = configuredBin || launcherBin;
    if (!selectedBin || !isAbsolute(selectedBin)) {
      throw new Error(
        `agent-bridge: selected provider ${provider} CLI requires an absolute path resolved before launcher PATH mutation`,
      );
    }
  }
  const defaultBin = launcherBin || PROVIDER_BIN_NAME[provider];
  return {
    agentBin: configuredBin || defaultBin,
    provider,
    model: config.model?.trim() || undefined,
    reasoningEffort: config.reasoningEffort ?? "high",
    capabilityMode: config.capabilityMode ?? (provider !== "claude" ? "one-shot" : "interactive"),
    allowedTools: config.allowedTools?.trim() || DEFAULTS.allowedTools,
    timeoutMs: config.timeoutMs ?? DEFAULTS.timeoutMs,
    maxReplyChars: config.maxReplyChars ?? DEFAULTS.maxReplyChars,
  };
}

// ---------------------------------------------------------------------------
// stream-json line aggregator (pure, exported for unit tests)
// ---------------------------------------------------------------------------

type StreamJsonAggregator = {
  feedLine(line: string): void;
  finalize(): { text: string; sessionId: string | null };
};

export function createStreamJsonAggregator(): StreamJsonAggregator {
  let sessionId: string | null = null;
  const textChunks: string[] = [];

  function feedLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // P2: drop malformed lines silently. P4 polish adds a fallback to text mode.
      return;
    }
    if (!isObject(parsed)) {
      return;
    }
    const type = parsed["type"];
    if (type === "system") {
      const sid = parsed["session_id"];
      if (typeof sid === "string" && sid.length > 0 && sessionId === null) {
        sessionId = sid;
      }
      return;
    }
    if (type === "assistant") {
      const message = parsed["message"];
      if (!isObject(message)) {
        return;
      }
      const content = message["content"];
      if (!Array.isArray(content)) {
        return;
      }
      for (const block of content) {
        if (!isObject(block)) {
          continue;
        }
        if (block["type"] === "text") {
          const t = block["text"];
          if (typeof t === "string" && t.length > 0) {
            textChunks.push(t);
          }
        }
      }
      return;
    }
    // `result`, `user` (tool_result echoes), and any other types are ignored
    // for the purpose of plain-text reply construction in P2.
  }

  function finalize() {
    return { text: textChunks.join(""), sessionId };
  }

  return { feedLine, finalize };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

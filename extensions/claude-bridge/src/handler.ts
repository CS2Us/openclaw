// Spawn `claude -p` and run a single turn. P2 uses stream-json so the bridge
// can capture `session_id` (for `--resume <id>` continuity) and accumulate
// assistant text incrementally. Permission decisions are still claude-local
// (P3 will route them through openclaw's ChannelApprovalHandler via an
// in-process MCP server).

import { spawn } from "node:child_process";

export type ClaudeBridgeConfig = {
  projectCwd?: string;
  claudeBin?: string;
  allowedTools?: string;
  timeoutMs?: number;
  maxReplyChars?: number;
};

const DEFAULTS = {
  claudeBin: "claude",
  allowedTools: "Read,Edit,Bash(git:*,cargo:*,ls,cat),Grep,Glob",
  timeoutMs: 300_000,
  maxReplyChars: 3_500,
} as const;

export type RunClaudeResult = {
  text: string;
  newSessionId: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
};

export function resolveProjectCwd(config: ClaudeBridgeConfig): string | undefined {
  // Env var wins so config can stay machine-portable (committable).
  const fromEnv = process.env.OPENCLAW_CLAUDE_BRIDGE_CWD?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const fromConfig = config.projectCwd?.trim();
  return fromConfig || undefined;
}

export type RunClaudeParams = {
  bin: string;
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
  const args = [
    "-p",
    params.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowed-tools",
    params.allowedTools,
  ];
  // Forward CLAUDE_BRIDGE_PERMISSION_MODE → `claude --permission-mode <mode>`.
  // Native Claude CLI semantics: "auto" uses the classifier (safe ops auto-
  // approve, risky ops still fire PreToolUse hook → bot approval card);
  // "bypassPermissions" allows everything (perm-hook never fires); "default"
  // asks for every tool (perm-hook always fires). Unset = let claude pick
  // its own default. Lets the bridge-spawned subprocess inherit the same
  // permission posture the IDE's `--permission-mode auto` provides.
  const permissionMode = process.env.CLAUDE_BRIDGE_PERMISSION_MODE?.trim();
  if (permissionMode) {
    args.push("--permission-mode", permissionMode);
  }
  if (params.resumeSessionId) {
    args.push("--resume", params.resumeSessionId);
  }
  if (params.permHookScriptPath) {
    const settings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: params.permHookScriptPath }],
          },
        ],
      },
    });
    args.push("--settings", settings, "--include-hook-events");
  }
  return args;
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

export function runClaude(params: RunClaudeParams): Promise<RunClaudeResult> {
  return new Promise((resolve, reject) => {
    const args = buildClaudeSpawnArgs(params);
    const env = buildClaudeSpawnEnv(params);

    const child = spawn(params.bin, args, {
      cwd: params.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const aggregator = createStreamJsonAggregator();
    let stdoutBuffer = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      let newlineIdx = stdoutBuffer.indexOf("\n");
      while (newlineIdx >= 0) {
        const line = stdoutBuffer.slice(0, newlineIdx);
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        aggregator.feedLine(line);
        newlineIdx = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
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
      if (stdoutBuffer.length > 0) {
        aggregator.feedLine(stdoutBuffer);
        stdoutBuffer = "";
      }
      const aggregated = aggregator.finalize();
      const text = formatReply({
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
  aggregatedText: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}): string {
  if (r.timedOut) {
    return `claude-bridge: timed out\n---\n${r.aggregatedText || r.stderr}`.trim();
  }
  if (r.exitCode === 0) {
    return r.aggregatedText.trim() || "(claude returned no output)";
  }
  return `claude-bridge: exit ${r.exitCode}${r.signal ? ` (${r.signal})` : ""}\n---\n${r.stderr || r.aggregatedText}`.trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n\n…(truncated, ${text.length - max} chars dropped)`;
}

export function resolveDefaults(config: ClaudeBridgeConfig) {
  return {
    claudeBin: config.claudeBin?.trim() || DEFAULTS.claudeBin,
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

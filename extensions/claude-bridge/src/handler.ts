// Inbound fallthrough handler for claude-bridge. Spawns `claude -p <text>` in
// the configured project cwd and returns the assistant's text. P1 keeps it
// stateless (every turn is a fresh claude process). P2 will introduce session
// continuity via stream-json + --resume; P3 will route tool permissions
// through openclaw's ChannelApprovalHandler via an in-process MCP server.

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

export function runClaudeOnce(params: {
  bin: string;
  cwd: string;
  allowedTools: string;
  timeoutMs: number;
  prompt: string;
}): Promise<RunClaudeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(params.bin, ["-p", params.prompt, "--allowed-tools", params.allowedTools], {
      cwd: params.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
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
      const text = formatReply({ stdout, stderr, exitCode, signal, timedOut });
      resolve({ text, exitCode, signal, timedOut });
    });
  });
}

function formatReply(r: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}): string {
  if (r.timedOut) {
    return `claude-bridge: timed out\n---\n${r.stdout || r.stderr}`.trim();
  }
  if (r.exitCode === 0) {
    return r.stdout.trim() || "(claude returned no output)";
  }
  return `claude-bridge: exit ${r.exitCode}${r.signal ? ` (${r.signal})` : ""}\n---\n${r.stderr || r.stdout}`.trim();
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

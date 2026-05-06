import { spawn } from "node:child_process";
import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";

type ClaudeBridgeConfig = {
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

export function createClaudeCommand(options: {
  pluginConfig?: unknown;
}): OpenClawPluginCommandDefinition {
  return {
    name: "claude",
    description:
      "Run a task in local Claude Code (headless `claude -p`) and reply with the result.",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleClaudeCommand(ctx, options),
  };
}

async function handleClaudeCommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown },
): Promise<PluginCommandResult> {
  const config = (options.pluginConfig ?? {}) as ClaudeBridgeConfig;
  const projectCwd = resolveProjectCwd(config);
  if (!projectCwd) {
    return {
      text:
        "claude-bridge: projectCwd is not configured.\n" +
        "Set it via plugin config (`projectCwd`) or env `OPENCLAW_CLAUDE_BRIDGE_CWD`.",
    };
  }

  const prompt = ctx.args?.trim() ?? "";
  if (!prompt) {
    return { text: "Usage: /claude <task description>" };
  }

  const claudeBin = config.claudeBin?.trim() || DEFAULTS.claudeBin;
  const allowedTools = config.allowedTools?.trim() || DEFAULTS.allowedTools;
  const timeoutMs = config.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxReplyChars = config.maxReplyChars ?? DEFAULTS.maxReplyChars;

  const result = await runClaude({
    bin: claudeBin,
    cwd: projectCwd,
    allowedTools,
    timeoutMs,
    prompt,
  });

  return { text: truncate(formatReply(result), maxReplyChars) };
}

function resolveProjectCwd(config: ClaudeBridgeConfig): string | undefined {
  // Env var wins so config can stay machine-portable (committable).
  const fromEnv = process.env.OPENCLAW_CLAUDE_BRIDGE_CWD?.trim();
  if (fromEnv) return fromEnv;
  const fromConfig = config.projectCwd?.trim();
  return fromConfig || undefined;
}

type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
};

function runClaude(params: {
  bin: string;
  cwd: string;
  allowedTools: string;
  timeoutMs: number;
  prompt: string;
}): Promise<RunResult> {
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
      resolve({ stdout, stderr, exitCode, signal, timedOut });
    });
  });
}

function formatReply(r: RunResult): string {
  if (r.timedOut) {
    return `claude-bridge: timed out\n---\n${r.stdout || r.stderr}`.trim();
  }
  if (r.exitCode === 0) {
    return r.stdout.trim() || "(claude returned no output)";
  }
  return `claude-bridge: exit ${r.exitCode}${r.signal ? ` (${r.signal})` : ""}\n---\n${r.stderr || r.stdout}`.trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n…(truncated, ${text.length - max} chars dropped)`;
}

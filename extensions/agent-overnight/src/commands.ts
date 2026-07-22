import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  isActivePhase,
  listStates,
  readState,
  resolveStateDir,
  writeStateAtomic,
  type OvernightState,
} from "./state.js";

export type OvernightConfig = {
  projectCwd?: string;
  agentBin?: string;
  provider?: "claude" | "codex" | "gemini";
  allowedTools?: string;
  stateDir?: string;
  maxIterations?: number;
  rateLimitFallbackSleepSec?: number;
  iterationTimeoutMs?: number;
};

const DEFAULTS = {
  agentBin: "agent",
  allowedTools:
    "Read,Edit,Write,Bash(git:*,cargo:*,pnpm:*,npm:*,ls,cat,grep,find,mkdir,rg),Grep,Glob,TodoWrite",
  maxIterations: 24,
  rateLimitFallbackSleepSec: 18_300,
  iterationTimeoutMs: 3_600_000,
} as const;

export function createOvernightCommand(opts: {
  pluginConfig?: unknown;
}): OpenClawPluginCommandDefinition {
  return {
    name: "overnight",
    description:
      "Spawn an unattended capability-gated provider: `/overnight <prompt>`. Auto-resumes across rate-limit windows.",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleOvernight(ctx, opts),
  };
}

export function createOvernightStatusCommand(opts: {
  pluginConfig?: unknown;
}): OpenClawPluginCommandDefinition {
  return {
    name: "overnight-status",
    description: "List recent overnight runs and their phase / iteration count.",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleStatus(ctx, opts),
  };
}

export function createOvernightStopCommand(opts: {
  pluginConfig?: unknown;
}): OpenClawPluginCommandDefinition {
  return {
    name: "overnight-stop",
    description:
      "Stop an overnight run: `/overnight-stop <sid>` (or no arg = stop the latest active).",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleStop(ctx, opts),
  };
}

function resolveProjectCwd(config: OvernightConfig): string | undefined {
  const fromEnv =
    process.env.OPENCLAW_AGENT_BRIDGE_CWD?.trim() || process.env.OPENCLAW_CLAUDE_BRIDGE_CWD?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return config.projectCwd?.trim() || undefined;
}

export function resolveOvernightCapabilityError(config: OvernightConfig): string | null {
  const provider = config.provider ?? "claude";
  if (provider === "claude") {
    return null;
  }
  return (
    `agent-overnight: provider ${provider} does not support required capabilities: ` +
    "resume, unattended_allowlist"
  );
}

function resolveDefaults(config: OvernightConfig) {
  return {
    agentBin: config.agentBin?.trim() || DEFAULTS.agentBin,
    allowedTools: config.allowedTools?.trim() || DEFAULTS.allowedTools,
    maxIterations: config.maxIterations ?? DEFAULTS.maxIterations,
    rateLimitFallbackSleepSec:
      config.rateLimitFallbackSleepSec ?? DEFAULTS.rateLimitFallbackSleepSec,
    iterationTimeoutMs: config.iterationTimeoutMs ?? DEFAULTS.iterationTimeoutMs,
  };
}

function resolveSupervisorScript(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "scripts", "overnight-supervisor.cjs"),
    path.join(here, "..", "agent-overnight", "scripts", "overnight-supervisor.cjs"),
    path.join(here, "..", "..", "agent-overnight", "scripts", "overnight-supervisor.cjs"),
    path.join(
      here,
      "..",
      "..",
      "..",
      "extensions",
      "agent-overnight",
      "scripts",
      "overnight-supervisor.cjs",
    ),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function handleOvernight(
  ctx: PluginCommandContext,
  opts: { pluginConfig?: unknown },
): Promise<PluginCommandResult> {
  const config = (opts.pluginConfig ?? {}) as OvernightConfig;
  const prompt = (ctx.args ?? "").trim();
  if (!prompt) {
    return {
      text:
        "用法：`/overnight <prompt>`\n" +
        "  示例：`/overnight 继续 chromite mtproto 的 D.2 跨语言测试向量任务`\n" +
        "  注意：守夜模式不挂 OpenClaw 权限 hook（你睡着了没法 approve），" +
        "只靠 `--allowed-tools` 白名单防呆。",
    };
  }

  const capabilityError = resolveOvernightCapabilityError(config);
  if (capabilityError) {
    return { text: capabilityError };
  }

  const projectCwd = resolveProjectCwd(config);
  if (!projectCwd) {
    return {
      text:
        "agent-overnight: projectCwd 未配置。设 env `OPENCLAW_AGENT_BRIDGE_CWD` " +
        "或插件 config.projectCwd。",
    };
  }

  const supervisor = resolveSupervisorScript();
  if (!supervisor) {
    return { text: "agent-overnight: 找不到 supervisor 脚本（scripts/overnight-supervisor.cjs）" };
  }

  const botToken = process.env.TG_BOT_TOKEN?.trim();
  if (!botToken) {
    return {
      text:
        "agent-overnight: 环境里没有 TG_BOT_TOKEN —— 进度无法回报 Telegram。\n" +
        "确认 openclaw 是用 scripts/openclaw-start.sh 启动的（它会注入这个 env）。",
    };
  }

  const chatId = ctx.to ?? ctx.from ?? ctx.senderId;
  if (!chatId) {
    return { text: "agent-overnight: 无法解析 Telegram chat id" };
  }

  const defaults = resolveDefaults(config);
  const stateDir = resolveStateDir(projectCwd, config.stateDir);

  const sid = randomUUID();
  const startedAt = new Date().toISOString();

  // Pre-write a "starting" state so /overnight-status sees it immediately,
  // even before the detached supervisor wakes up.
  const initialState: OvernightState = {
    sid,
    pid: null,
    phase: "starting",
    prompt,
    cwd: projectCwd,
    startedAt,
    updatedAt: startedAt,
    iterations: 0,
    maxIterations: defaults.maxIterations,
    resumeAt: null,
    lastEvent: "queued",
    finalText: null,
  };
  writeStateAtomic(stateDir, initialState);

  const child = spawn(
    process.execPath,
    [
      // Honor $https_proxy / $http_proxy in supervisor's native fetch().
      // Without this, supervisor's notify trail vanishes on transparent-proxy
      // networks (Clash fake-IP api.telegram.org). See 2026-05-11 overnight
      // first-run discovery.
      "--use-env-proxy",
      supervisor,
      "--sid",
      sid,
      "--state-dir",
      stateDir,
      "--cwd",
      projectCwd,
      "--claude-bin",
      defaults.agentBin,
      "--allowed-tools",
      defaults.allowedTools,
      "--max-iterations",
      String(defaults.maxIterations),
      "--rate-limit-fallback-sec",
      String(defaults.rateLimitFallbackSleepSec),
      "--iteration-timeout-ms",
      String(defaults.iterationTimeoutMs),
      "--telegram-chat-id",
      chatId,
      "--prompt",
      prompt,
    ],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        // Supervisor messages Telegram directly; OpenClaw stays out of the
        // overnight path entirely (it can crash & supervisor still runs).
        TG_BOT_TOKEN: botToken,
      },
    },
  );

  child.unref();

  return {
    text:
      `🌙 守夜启动\n` +
      `sid: \`${sid}\`\n` +
      `cwd: ${projectCwd}\n` +
      `task: ${prompt.length > 200 ? `${prompt.slice(0, 200)}…` : prompt}\n` +
      `命中 5h 上限会自动 sleep + resume，上限 ${defaults.maxIterations} 轮。\n` +
      `\`/overnight-status\` 看进度，\`/overnight-stop ${sid}\` 终止。`,
  };
}

async function handleStatus(
  ctx: PluginCommandContext,
  opts: { pluginConfig?: unknown },
): Promise<PluginCommandResult> {
  const config = (opts.pluginConfig ?? {}) as OvernightConfig;
  const projectCwd = resolveProjectCwd(config);
  if (!projectCwd) {
    return { text: "agent-overnight: projectCwd 未配置" };
  }
  const stateDir = resolveStateDir(projectCwd, config.stateDir);
  const specificSid = (ctx.args ?? "").trim();

  if (specificSid) {
    const s = readState(stateDir, specificSid);
    if (!s) {
      return { text: `没找到 sid=${specificSid}` };
    }
    return { text: renderStateDetail(s) };
  }

  const all = listStates(stateDir);
  if (all.length === 0) {
    return { text: "还没有守夜记录。`/overnight <prompt>` 开始一次。" };
  }
  const lines = ["📋 最近的守夜任务（最近 10 条）："];
  for (const s of all.slice(0, 10)) {
    lines.push(renderStateLine(s));
  }
  return { text: lines.join("\n") };
}

async function handleStop(
  ctx: PluginCommandContext,
  opts: { pluginConfig?: unknown },
): Promise<PluginCommandResult> {
  const config = (opts.pluginConfig ?? {}) as OvernightConfig;
  const projectCwd = resolveProjectCwd(config);
  if (!projectCwd) {
    return { text: "agent-overnight: projectCwd 未配置" };
  }
  const stateDir = resolveStateDir(projectCwd, config.stateDir);
  const sidArg = (ctx.args ?? "").trim();

  let target: OvernightState | null = null;
  if (sidArg) {
    target = readState(stateDir, sidArg);
    if (!target) {
      return { text: `没找到 sid=${sidArg}` };
    }
  } else {
    const active = listStates(stateDir).find((s) => isActivePhase(s.phase));
    if (!active) {
      return { text: "当前没有活跃的守夜任务可停。" };
    }
    target = active;
  }

  if (!isActivePhase(target.phase)) {
    return { text: `sid=${target.sid} 已经是 ${target.phase}，无需 stop。` };
  }
  if (target.pid == null) {
    return { text: `sid=${target.sid} 还没拿到 pid（刚 starting？稍等再试）。` };
  }

  try {
    process.kill(target.pid, "SIGTERM");
  } catch (err) {
    return {
      text:
        `kill pid=${target.pid} 失败：${err instanceof Error ? err.message : String(err)}\n` +
        `进程可能已退出但 state 没及时刷新；手动检查 ${stateDir}/${target.sid}.json`,
    };
  }
  return {
    text:
      `🛑 已向 sid=${target.sid} (pid=${target.pid}) 发 SIGTERM。\n` +
      `supervisor 会标记为 stopped 并退出。`,
  };
}

function renderStateLine(s: OvernightState): string {
  const phaseIcon =
    s.phase === "completed"
      ? "✅"
      : s.phase === "failed"
        ? "❌"
        : s.phase === "stopped"
          ? "🛑"
          : s.phase === "rate-limited-sleeping"
            ? "💤"
            : "▶️";
  const tail =
    s.phase === "rate-limited-sleeping" && s.resumeAt
      ? ` → 醒于 ${s.resumeAt}`
      : ` iter ${s.iterations}/${s.maxIterations}`;
  return `${phaseIcon} \`${s.sid.slice(0, 8)}\` ${s.phase}${tail} — ${s.lastEvent}`;
}

function renderStateDetail(s: OvernightState): string {
  const lines = [
    `sid: \`${s.sid}\``,
    `phase: ${s.phase}`,
    `iterations: ${s.iterations}/${s.maxIterations}`,
    `started: ${s.startedAt}`,
    `updated: ${s.updatedAt}`,
  ];
  if (s.pid != null) {
    lines.push(`pid: ${s.pid}`);
  }
  if (s.resumeAt) {
    lines.push(`resumeAt: ${s.resumeAt}`);
  }
  lines.push(`lastEvent: ${s.lastEvent}`);
  if (s.finalText) {
    const preview = s.finalText.length > 500 ? `${s.finalText.slice(0, 500)}…` : s.finalText;
    lines.push(`---\n${preview}`);
  }
  return lines.join("\n");
}

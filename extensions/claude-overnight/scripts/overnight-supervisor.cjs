#!/usr/bin/env node
// Standalone supervisor for one overnight run.
//
// Invoked detached by claude-overnight/src/commands.ts. Owns the run from
// start to terminal state (completed / failed / stopped). No openclaw runtime
// dependency at runtime — only Telegram bot HTTP API for notifications and a
// plain JSON state file for /overnight-status to read.
//
// Args:
//   --sid <uuid>                 stable session id for `claude --resume`
//   --state-dir <path>           where to write <sid>.json
//   --cwd <path>                 cwd for `claude`
//   --claude-bin <bin>           `claude` binary
//   --allowed-tools <csv>        passed to claude --allowed-tools
//   --max-iterations <n>         safety cap on continue-loop turns
//   --rate-limit-fallback-sec <n>  sleep when retry-after unparseable
//   --iteration-timeout-ms <n>   kill claude after this long per turn
//   --telegram-chat-id <id>      destination for progress messages
//   --prompt <text>              the goal for the night
//
// Env:
//   TG_BOT_TOKEN                 Telegram bot token (required for notify)
//
// State file is the single source of truth. Commands read it; we write it
// atomically (tmp+rename) on every phase change.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

// ---- argv parsing ---------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const val = argv[i + 1];
    if (!key || !key.startsWith("--") || val === undefined) {
      continue;
    }
    out[key.slice(2)] = val;
  }
  return out;
}

const args = parseArgs(process.argv);
const SID = args.sid;
const STATE_DIR = args["state-dir"];
const CWD = args.cwd;
const CLAUDE_BIN = args["claude-bin"] || "claude";
const ALLOWED_TOOLS = args["allowed-tools"];
const MAX_ITERS = parseInt(args["max-iterations"] || "24", 10);
const RATE_FALLBACK_SEC = parseInt(args["rate-limit-fallback-sec"] || "18300", 10);
const ITER_TIMEOUT_MS = parseInt(args["iteration-timeout-ms"] || "3600000", 10);
// Normalize chat id: openclaw command ctx may give the openclaw session-key
// format (e.g. "telegram:5028451986") rather than the raw Telegram chat id.
// Telegram bot API needs the raw numeric id; strip any "<channel>:" prefix and
// any trailing ":<thread>" suffix.
const CHAT_ID = (function normalizeChatId(raw) {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  // "telegram:NUMERIC" or "telegram:NUMERIC:thread" → take middle/last numeric
  const m = s.match(/^(?:[a-z][a-z0-9-]*:)?(-?\d+)(?::|$)/i);
  return m ? m[1] : s;
})(args["telegram-chat-id"]);
const PROMPT = args.prompt;
const TG_TOKEN = process.env.TG_BOT_TOKEN || "";

if (!SID || !STATE_DIR || !CWD || !ALLOWED_TOOLS || !CHAT_ID || !PROMPT) {
  // Fatal config error — bail with non-zero so detached parent at least
  // surfaces *something* in `state.starting → never updates`.
  process.stderr.write("[overnight-supervisor] missing required args\n");
  process.exit(2);
}

// ---- state file -----------------------------------------------------------

const STATE_FILE = path.join(STATE_DIR, `${SID}.json`);
const LOG_FILE = path.join(STATE_DIR, `${SID}.log`);

function nowIso() {
  return new Date().toISOString();
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    // Race with commands.ts which pre-writes the file: very unlikely but be
    // defensive. Fall back to a synthetic state.
    return {
      sid: SID,
      pid: null,
      phase: "starting",
      prompt: PROMPT,
      cwd: CWD,
      startedAt: nowIso(),
      updatedAt: nowIso(),
      iterations: 0,
      maxIterations: MAX_ITERS,
      resumeAt: null,
      lastEvent: "synthetic-read",
      finalText: null,
    };
  }
}

function writeState(patch) {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
  const prev = readState();
  const next = { ...prev, ...patch, updatedAt: nowIso() };
  const tmp = `${STATE_FILE}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, STATE_FILE);
  return next;
}

function appendLog(line) {
  try {
    fs.appendFileSync(LOG_FILE, `[${nowIso()}] ${line}\n`);
  } catch {
    // ignore — log is best-effort
  }
}

// ---- Telegram notify ------------------------------------------------------

// Use Node's native fetch() — it honors $HTTPS_PROXY / $http_proxy when node
// is invoked with --use-env-proxy (added in Node 24+). Supervisor is spawned
// by commands.ts with `--use-env-proxy` for exactly this reason: on transparent-
// proxy networks (Clash fake-IP api.telegram.org), direct connect to fake IP
// fails silently — only by going through the local proxy can sendMessage land.
//
// 2026-05-11 first /overnight run: supervisor's notify trail vanished
// (claude completed but you got 0 of 3 supervisor messages). The command-
// handler ack message in commands.ts handleRun() went through fine because it
// flows back via daemon's telegram channel which has proxy wiring; supervisor
// is a detached cjs that didn't (until this fix).
async function telegramSend(text) {
  if (!TG_TOKEN) {
    appendLog("telegram: TG_TOKEN missing");
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Keep this — without it the 2026-05-11 first-run "chat not found"
      // bug stayed silent for 4 supervisor invocations. rc + body lets future
      // debuggers see the Telegram API response (400 / 401 / rate limit / …).
      const body = await res.text().catch(() => "");
      appendLog(`telegram send rc=${res.status} body=${body.slice(0, 200)}`);
    }
    return res.ok;
  } catch (err) {
    appendLog(
      `telegram send error: name=${err && err.name} message=${err && err.message} cause=${err && err.cause && err.cause.code}`,
    );
    return false;
  }
}

async function notify(text) {
  appendLog(`notify: ${text}`);
  await telegramSend(text);
}

// ---- claude spawn ---------------------------------------------------------

function buildArgs(iteration) {
  // First iteration: open the session with --session-id <sid> + initial prompt.
  // Later iterations: resume with --resume <sid> and a continuation nudge.
  const base = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowed-tools",
    ALLOWED_TOOLS,
    "--permission-mode",
    "default",
  ];
  if (iteration === 1) {
    base.push("--session-id", SID, PROMPT);
  } else {
    base.push(
      "--resume",
      SID,
      "继续刚才的任务。如果任务已经完成，请回复 `OVERNIGHT_DONE` 然后停止；" +
        "否则按你的判断执行下一步。",
    );
  }
  return base;
}

function runClaudeOnce(iteration) {
  return new Promise((resolve) => {
    const claudeArgs = buildArgs(iteration);
    appendLog(`spawn: ${CLAUDE_BIN} ${claudeArgs.map((a) => JSON.stringify(a)).join(" ")}`);
    const child = spawn(CLAUDE_BIN, claudeArgs, {
      cwd: CWD,
      env: {
        ...process.env,
        // Belt-and-suspenders: never inherit a perm-hook into the headless run.
        OPENCLAW_GATE_BYPASS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    let assistantText = "";
    let timedOut = false;

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      let nl = stdoutBuf.indexOf("\n");
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        assistantText += extractAssistantText(line);
        nl = stdoutBuf.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
    });

    const killer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 5_000).unref();
    }, ITER_TIMEOUT_MS);
    killer.unref();

    child.on("close", (exitCode, signal) => {
      clearTimeout(killer);
      if (stdoutBuf.length > 0) {
        assistantText += extractAssistantText(stdoutBuf);
      }
      appendLog(`exit ${exitCode} signal=${signal} timedOut=${timedOut}`);
      if (stderrBuf) {
        appendLog(`stderr: ${stderrBuf.slice(-2000)}`);
      }
      resolve({
        exitCode,
        signal,
        timedOut,
        assistantText,
        stderr: stderrBuf,
      });
    });
    child.on("error", (err) => {
      clearTimeout(killer);
      appendLog(`spawn-error: ${err.message}`);
      resolve({
        exitCode: -1,
        signal: null,
        timedOut: false,
        assistantText: "",
        stderr: err.message,
      });
    });
  });
}

function extractAssistantText(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return "";
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object" || parsed.type !== "assistant") {
    return "";
  }
  const message = parsed.message;
  if (!message || !Array.isArray(message.content)) {
    return "";
  }
  let out = "";
  for (const block of message.content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      out += block.text;
    }
  }
  return out;
}

// ---- rate-limit detection -------------------------------------------------
//
// First overnight will surface the real error format — until then we match
// broad patterns. We log raw stderr so the user can tune this regex after
// observing a real hit. Heuristics, ordered by signal strength:
//
//   1. Anthropic-style "rate_limit" / "rate limit" in stderr.
//   2. CLI exit code combined with phrases like "5-hour limit" / "weekly
//      limit" / "quota" / "usage limit".
//   3. Explicit retry-after epoch seconds in stderr (e.g. "resetAt": 17...).
//
// If matched, we try to extract a target wake epoch; otherwise fall back to
// the configured RATE_FALLBACK_SEC.

const RATE_LIMIT_PHRASES = [
  /rate[_ ]?limit/i,
  /5[- ]?hour\s+limit/i,
  /weekly\s+limit/i,
  /usage\s+limit/i,
  /quota\s+exceed/i,
  /429/,
];

function isRateLimited(result) {
  if (result.exitCode === 0) {
    return false;
  }
  const haystack = `${result.stderr || ""}\n${result.assistantText || ""}`;
  return RATE_LIMIT_PHRASES.some((re) => re.test(haystack));
}

function parseResumeTimestampMs(stderr) {
  if (!stderr) {
    return null;
  }
  // Try "resetAt": 1750000000 / "reset_at": 1.75e9 / "retry-after": 12345
  const epochMatch = stderr.match(/reset[_ ]?at["':\s]+(\d{10,13})/i);
  if (epochMatch) {
    const n = parseInt(epochMatch[1], 10);
    return epochMatch[1].length === 10 ? n * 1000 : n;
  }
  const retryAfterMatch = stderr.match(/retry[- ]?after["':\s]+(\d+)/i);
  if (retryAfterMatch) {
    return Date.now() + parseInt(retryAfterMatch[1], 10) * 1000;
  }
  // ISO-8601 reset?
  const isoMatch = stderr.match(/reset[_ ]?at["':\s]+["']?(\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?)/i);
  if (isoMatch) {
    const t = Date.parse(isoMatch[1]);
    if (!Number.isNaN(t)) {
      return t;
    }
  }
  return null;
}

// ---- termination handling -------------------------------------------------

let stopRequested = false;
process.on("SIGTERM", () => {
  stopRequested = true;
  appendLog("SIGTERM received");
});
process.on("SIGINT", () => {
  stopRequested = true;
  appendLog("SIGINT received");
});

// ---- main loop ------------------------------------------------------------

async function main() {
  writeState({ pid: process.pid, phase: "running", lastEvent: "supervisor started" });
  await notify(
    `🌙 守夜启动 sid=\`${SID.slice(0, 8)}\`\n` +
      `cwd: ${CWD}\n` +
      `goal: ${PROMPT.length > 200 ? `${PROMPT.slice(0, 200)}…` : PROMPT}`,
  );

  for (let iter = 1; iter <= MAX_ITERS; iter += 1) {
    if (stopRequested) {
      writeState({ phase: "stopped", lastEvent: `stopped before iter ${iter}` });
      await notify(`🛑 sid=\`${SID.slice(0, 8)}\` 已停止（用户请求）`);
      return;
    }

    writeState({
      iterations: iter,
      phase: "running",
      lastEvent: `iter ${iter} running`,
      resumeAt: null,
    });
    if (iter === 1) {
      await notify(`▶️ iter ${iter} 开跑…`);
    }

    const result = await runClaudeOnce(iter);

    if (stopRequested) {
      writeState({ phase: "stopped", lastEvent: `stopped after iter ${iter}` });
      await notify(`🛑 sid=\`${SID.slice(0, 8)}\` 已停止（用户请求）`);
      return;
    }

    // Done signal: claude printed our OVERNIGHT_DONE token.
    if (result.exitCode === 0 && /OVERNIGHT_DONE/.test(result.assistantText)) {
      const final = trim(result.assistantText, 4000);
      writeState({ phase: "completed", lastEvent: `done at iter ${iter}`, finalText: final });
      await notify(
        `✅ sid=\`${SID.slice(0, 8)}\` 任务完成 (iter ${iter})\n` +
          `--- claude 最后一段 ---\n${trim(result.assistantText, 1500)}`,
      );
      return;
    }

    // Normal exit but no DONE marker: nudge with continuation prompt next iter.
    if (result.exitCode === 0) {
      writeState({
        phase: "running",
        lastEvent: `iter ${iter} returned without DONE, continuing`,
      });
      await notify(
        `↻ iter ${iter} 完成但没收到 DONE；继续。\n` + `输出尾：${trim(result.assistantText, 400)}`,
      );
      continue;
    }

    // Timeout: log, then continue (might be a long-running task).
    if (result.timedOut) {
      writeState({
        phase: "running",
        lastEvent: `iter ${iter} timed out after ${ITER_TIMEOUT_MS}ms, continuing`,
      });
      await notify(`⏱ iter ${iter} 超 ${Math.round(ITER_TIMEOUT_MS / 60000)}min 被杀；继续下一轮`);
      continue;
    }

    // Rate-limit: sleep and try again.
    if (isRateLimited(result)) {
      const parsedMs = parseResumeTimestampMs(result.stderr);
      const wakeMs = parsedMs ?? Date.now() + RATE_FALLBACK_SEC * 1000;
      const wakeIso = new Date(wakeMs).toISOString();
      const sleepMs = Math.max(60_000, wakeMs - Date.now());
      writeState({
        phase: "rate-limited-sleeping",
        resumeAt: wakeIso,
        lastEvent: `rate-limited at iter ${iter}, sleeping ${Math.round(sleepMs / 60000)}min`,
      });
      await notify(
        `💤 sid=\`${SID.slice(0, 8)}\` 命中 5h 上限，sleep 到 ${wakeIso}\n` +
          `iter ${iter} stderr 摘：${trim(result.stderr, 400)}`,
      );
      await interruptibleSleep(sleepMs);
      if (stopRequested) {
        writeState({ phase: "stopped", lastEvent: "stopped during rate-limit sleep" });
        await notify(`🛑 sid=\`${SID.slice(0, 8)}\` 已停止（睡眠中收到停止信号）`);
        return;
      }
      continue;
    }

    // Unknown failure: report and abort. The user wakes up to a useful error
    // rather than infinite retry on a real bug.
    writeState({
      phase: "failed",
      lastEvent: `iter ${iter} unknown failure exit=${result.exitCode}`,
      finalText: trim(result.stderr || result.assistantText, 4000),
    });
    await notify(
      `❌ sid=\`${SID.slice(0, 8)}\` 未知错误退出 (iter ${iter}, exit=${result.exitCode})\n` +
        `stderr: ${trim(result.stderr, 800)}`,
    );
    return;
  }

  writeState({ phase: "failed", lastEvent: `hit maxIterations=${MAX_ITERS}` });
  await notify(`⚠️ sid=\`${SID.slice(0, 8)}\` 达到 maxIterations=${MAX_ITERS} 未完成，stop`);
}

function trim(text, max) {
  if (!text) {
    return "";
  }
  return text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;
}

function interruptibleSleep(ms) {
  return new Promise((resolve) => {
    const tick = 30_000;
    let remaining = ms;
    const handle = setInterval(() => {
      if (stopRequested) {
        clearInterval(handle);
        resolve();
        return;
      }
      remaining -= tick;
      if (remaining <= 0) {
        clearInterval(handle);
        resolve();
      }
    }, tick);
  });
}

main().catch(async (err) => {
  appendLog(`fatal: ${err && err.stack ? err.stack : String(err)}`);
  writeState({
    phase: "failed",
    lastEvent: `supervisor crashed: ${err && err.message ? err.message : String(err)}`,
  });
  await notify(
    `💥 sid=\`${SID.slice(0, 8)}\` supervisor 崩溃：${err && err.message ? err.message : String(err)}`,
  );
  process.exit(1);
});

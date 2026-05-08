#!/usr/bin/env node
// claude-bridge PreToolUse hook. Bridges every claude tool intent to the
// openclaw approval pipeline (plugin.approval.request + .waitDecision) so
// users approve through Telegram with always-allow / audit / group-policy
// reuse — see docs/specs/2026-05-07-claude-bridge-agent-harness.md §3.4-§3.6.
//
// Stdin (claude-injected JSON):
//   {tool_name, tool_input, tool_use_id, session_id, cwd, ...}
// Env (set by claude-bridge before spawning claude):
//   OPENCLAW_GATEWAY_URL              ws://127.0.0.1:18789 by default
//   OPENCLAW_GATEWAY_PASSWORD         shared operator password (required)
//   OPENCLAW_TURN_AGENT_ID            routing → plugin.approval.request
//   OPENCLAW_TURN_SESSION_KEY
//   OPENCLAW_TURN_SOURCE_CHANNEL
//   OPENCLAW_TURN_SOURCE_TO
//   OPENCLAW_TURN_SOURCE_ACCOUNT_ID
//   OPENCLAW_TURN_SOURCE_THREAD_ID    optional; numeric → number, else string
// Stdout:
//   JSON {hookSpecificOutput:{hookEventName,permissionDecision,permissionDecisionReason}}
// Exit:
//   Always 0. Any unrecoverable error → emit "deny" + stderr.
//
// IMPORTANT: keep mapOpenclawDecisionToClaude / buildApprovalRequestParams /
// formatToolDescription in sync with src/perm-hook-decision.ts (which has
// strict-typed unit coverage).

"use strict";

const WebSocket = require("ws");

const HOOK_OVERALL_TIMEOUT_MS = 120_000;
const APPROVAL_TIMEOUT_MS = 110_000; // <120s overall so server-side timeout fires first
const URL = process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789";
const PASSWORD = process.env.OPENCLAW_GATEWAY_PASSWORD;

let resolved = false;
const overallTimer = setTimeout(
  () => denyAndExit("hook overall timeout (120s)"),
  HOOK_OVERALL_TIMEOUT_MS,
);
overallTimer.unref();

function emitDecisionAndExit(decision, reason, exitCode) {
  if (resolved) {
    return;
  }
  resolved = true;
  clearTimeout(overallTimer);
  const payload = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(typeof exitCode === "number" ? exitCode : 0);
}

function denyAndExit(reason) {
  process.stderr.write(`[perm-hook] ${reason}\n`);
  emitDecisionAndExit("deny", reason, 0);
}

if (!PASSWORD) {
  denyAndExit("OPENCLAW_GATEWAY_PASSWORD missing");
}

let stdinBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk;
});
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(stdinBuf);
  } catch (err) {
    denyAndExit(`bad stdin JSON: ${err && err.message ? err.message : err}`);
    return;
  }
  bridge(input).catch((err) => {
    denyAndExit(`unexpected: ${err && err.message ? err.message : String(err)}`);
  });
});
process.stdin.on("error", (err) => {
  denyAndExit(`stdin error: ${err.message}`);
});

async function bridge(input) {
  let ws;
  try {
    ws = new WebSocket(URL);
  } catch (err) {
    denyAndExit(`ws ctor: ${err.message}`);
    return;
  }

  const inflight = new Map();
  let nextId = 1;

  function sendReq(method, params) {
    return new Promise((resolveReq, rejectReq) => {
      const id = `h${nextId++}`;
      inflight.set(id, { resolve: resolveReq, reject: rejectReq });
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg && msg.type === "res") {
      const pending = inflight.get(msg.id);
      if (!pending) {
        return;
      }
      inflight.delete(msg.id);
      if (msg.ok) {
        pending.resolve(msg.payload);
      } else {
        const code = msg.error && msg.error.code ? msg.error.code : "ERR";
        const message = msg.error && msg.error.message ? msg.error.message : "unknown";
        pending.reject(new Error(`${code}: ${message}`));
      }
    }
    // events ignored (connect.challenge / plugin.approval.requested / etc.)
  });
  ws.on("error", (err) => {
    denyAndExit(`ws error: ${err.message}`);
  });

  await new Promise((resolveOpen, rejectOpen) => {
    ws.once("open", resolveOpen);
    ws.once("close", () => rejectOpen(new Error("ws closed before open")));
  });

  await sendReq("connect", {
    minProtocol: 3,
    maxProtocol: 3,
    client: { id: "gateway-client", version: "1.0.0", platform: "node", mode: "backend" },
    scopes: ["operator.approvals"],
    auth: { password: PASSWORD },
  });

  const reqResult = await sendReq(
    "plugin.approval.request",
    buildApprovalRequestParams(input, process.env, APPROVAL_TIMEOUT_MS),
  );
  const approvalId = reqResult && reqResult.id;
  if (!approvalId) {
    denyAndExit("plugin.approval.request returned no id");
    return;
  }

  const wait = await sendReq("plugin.approval.waitDecision", { id: approvalId });
  const decision = wait && wait.decision;
  try {
    ws.close(1000, "done");
  } catch {
    // ignore
  }
  emitClaudeDecision(decision);
}

// ---- inline helpers (keep in sync with src/perm-hook-decision.ts) ----

function buildApprovalRequestParams(input, env, approvalTimeoutMs) {
  const description = formatToolDescription(input.tool_name, input.tool_input);
  const params = {
    pluginId: "claude-bridge",
    title: input.tool_name || "tool",
    description,
    severity: "warning",
    toolName: input.tool_name || "unknown",
    toolCallId: input.tool_use_id,
    agentId: env.OPENCLAW_TURN_AGENT_ID || "claude-bridge",
    sessionKey: env.OPENCLAW_TURN_SESSION_KEY || "claude-bridge-session",
    turnSourceChannel: env.OPENCLAW_TURN_SOURCE_CHANNEL || "telegram",
    turnSourceTo: env.OPENCLAW_TURN_SOURCE_TO || "0",
    turnSourceAccountId: env.OPENCLAW_TURN_SOURCE_ACCOUNT_ID || "default",
    timeoutMs: approvalTimeoutMs,
    twoPhase: true,
  };
  // threadId schema is string|number; DM has no thread → omit field.
  const rawTid = env.OPENCLAW_TURN_SOURCE_THREAD_ID;
  if (rawTid && rawTid.length > 0) {
    if (/^-?\d+$/.test(rawTid)) {
      params.turnSourceThreadId = Number(rawTid);
    } else {
      params.turnSourceThreadId = rawTid;
    }
  }
  return params;
}

function formatToolDescription(toolName, toolInput) {
  const lines = [`Tool: ${toolName || "?"}`];
  if (toolInput !== undefined && toolInput !== null) {
    let json = "";
    try {
      json = JSON.stringify(toolInput);
    } catch {
      json = "";
    }
    if (json.length > 0) {
      lines.push(json.length > 200 ? `${json.slice(0, 200)}…` : json);
    }
  }
  return lines.join("\n");
}

function emitClaudeDecision(decision) {
  if (decision === "allow-once") {
    emitDecisionAndExit("allow", "approved by user (this turn)");
  } else if (decision === "allow-always") {
    emitDecisionAndExit("allow", "approved by user (always)");
  } else if (decision === "deny") {
    emitDecisionAndExit("deny", "denied by user");
  } else {
    emitDecisionAndExit("deny", "approval timed out or unavailable");
  }
}

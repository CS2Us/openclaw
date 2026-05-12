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
//   TG_BOT_TOKEN                      optional; when channel=telegram, enables
//                                     a "session X 等待审批 [👁 进入]" companion
//                                     message alongside the standard openclaw
//                                     approval card. See docs/specs/
//                                     2026-05-12-claude-bridge-contextual-approval.md
// Stdout:
//   JSON {hookSpecificOutput:{hookEventName,permissionDecision,permissionDecisionReason}}
// Exit:
//   Always 0. Any unrecoverable error → emit "deny" + stderr.
//
// IMPORTANT: keep mapOpenclawDecisionToClaude / buildApprovalRequestParams /
// formatToolDescription in sync with src/perm-hook-decision.ts (which has
// strict-typed unit coverage).

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");

const HOOK_OVERALL_TIMEOUT_MS = 120_000;
const APPROVAL_TIMEOUT_MS = 110_000; // <120s overall so server-side timeout fires first
const NUDGE_WAIT_TIMEOUT_MS = 100_000; // <120s overall; leaves slack for the approval round-trip
const NUDGE_POLL_INTERVAL_MS = 500;
const FOLLOW_MARKER_DIR = "/tmp/openclaw/follow-markers";
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
  // Stage 1 — gate on "is this session being followed in Telegram?"
  //
  // If yes: skip the nudge, go straight to approval (card will land in the
  // follow stream the user is already watching — full context).
  //
  // If no: send a `[👁 进入 session]` companion message and BLOCK until the
  // user clicks it (which writes the follow marker from the bot daemon's
  // enterAndFollow handler). Only then do we call plugin.approval.request,
  // so the standard openclaw approval card appears inside the now-followed
  // stream rather than as an OOB shout.
  //
  // Timeout → deny. Same overall 120s budget; nudge wait + approval round-
  // trip together must fit. Practically: ~100s for the user to react +
  // remaining 20s for the approval ws hop.
  const sessionId = input.session_id;
  const chatId = process.env.OPENCLAW_TURN_SOURCE_TO;
  const channel = process.env.OPENCLAW_TURN_SOURCE_CHANNEL;
  const tgToken = process.env.TG_BOT_TOKEN;

  let nudgeMessageId = null;
  if (
    sessionId &&
    chatId &&
    tgToken &&
    channel === "telegram" &&
    !isFollowingSession(chatId, sessionId)
  ) {
    nudgeMessageId = await sendApprovalCompanion(input, process.env).catch((err) => {
      process.stderr.write(`[perm-hook] nudge send failed: ${err && err.message}\n`);
      return null;
    });
    const entered = await waitForFollowMarker(chatId, sessionId, NUDGE_WAIT_TIMEOUT_MS);
    if (!entered) {
      // Best-effort: edit nudge to reflect the timeout so the user understands
      // the [👁] button is now stale.
      if (nudgeMessageId) {
        await clearApprovalCompanionButtons(nudgeMessageId, process.env).catch(() => {});
      }
      denyAndExit("nudge timeout: user did not enter session within 100s");
      return;
    }
  }

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

  // Bypass openclaw's telegram channel approval handler entirely: send our
  // own decision card directly so the UX lives 100% in claude-bridge (matches
  // the rest of the follow-stream visuals + sidesteps the grammY-through-Clash
  // proxy reliability problem). Layers 1-3 of the openclaw policy gate
  // (BYPASS / hard rules / LLM arbitrate) still run because we did call
  // plugin.approval.request above — they short-circuit waitDecision below.
  let approvalCardMessageId = null;
  if (sessionId && chatId && tgToken && channel === "telegram") {
    approvalCardMessageId = await sendOwnApprovalCard({
      input,
      approvalId,
      env: process.env,
    }).catch((err) => {
      process.stderr.write(`[perm-hook] own approval card failed: ${err && err.message}\n`);
      return null;
    });
  }

  // Resolution races between three sources — first to settle wins:
  //
  //   1. openclaw policy gate layers 1-3 (BYPASS / hard rules / LLM arbitrate)
  //      auto-resolve via the openclaw approval engine → waitDecision returns.
  //
  //   2. Daemon's interactive handler picks up the user's button click via
  //      grammY polling → daemon-gateway-client.resolveApproval() → waitDecision
  //      returns. **This is unreliable through Clash proxy** (idle TCP drops
  //      stall grammY's long-poll).
  //
  //   3. **NEW**: perm-hook polls Telegram directly via `fetch` (proven
  //      reliable through Clash — perm-hook already uses this path for its
  //      own card send + nudge). Filters for the user's click on *this*
  //      approval. When found, forwards through plugin.approval.resolve
  //      (which makes waitDecision return) + answers callback_query so the
  //      spinner clears. Bypasses grammY entirely, sidesteps polling stalls.
  //
  //   4. Server-side approval timeout (APPROVAL_TIMEOUT_MS=110s) fires if
  //      nothing else resolves.
  //
  // The direct-poll runs alongside waitDecision in a Promise.race. They share
  // the same approval state on the openclaw side — whichever calls resolve
  // first sets the decision; the other observes it via the same response.
  const directPollPromise = pollTelegramForOwnApprovalDecision({
    approvalId,
    env: process.env,
    sendReq,
  });
  const waitPromise = sendReq("plugin.approval.waitDecision", { id: approvalId });

  const wait = await waitPromise;
  const decision = wait && wait.decision;

  // Let the direct-poll loop see that the approval is resolved and exit.
  await directPollPromise.catch(() => {});

  // Edit our own card to show the final resolution + drop buttons.
  if (approvalCardMessageId) {
    await editOwnApprovalCard({
      messageId: approvalCardMessageId,
      decision,
      env: process.env,
    }).catch(() => {});
  }

  // Drop the [👁 进入] button from the upfront nudge (if we sent one) since
  // the approval is now settled and the button is a stale tap target.
  if (nudgeMessageId) {
    await clearApprovalCompanionButtons(nudgeMessageId, process.env).catch(() => {});
  }

  try {
    ws.close(1000, "done");
  } catch {
    // ignore
  }
  emitClaudeDecision(decision);
}

// ---- side-channel poll for own approval callback (bypasses grammY) ----
//
// Why this exists:
//   The bot daemon's grammY long-poll goes through the Clash transparent
//   proxy and gets silently stalled on idle TCP drops (recovery takes 15s+
//   per cycle, sometimes blocking callback delivery past the 110s server-
//   side approval timeout). perm-hook uses direct `fetch()` for sending —
//   which honors HTTPS_PROXY via NODE_OPTIONS=--use-env-proxy and is empiri-
//   cally stable through Clash. This loop applies the same trick for the
//   inbound direction: poll getUpdates ourselves with a short timeout, filter
//   for the user's button tap on *this* approval, forward to plugin.approval.
//   resolve so waitDecision returns.
//
// Coexistence with grammY:
//   Two pollers on the same bot token normally conflict (409). Empirically
//   verified: short-timeout (timeout=1) getUpdates calls do NOT trigger the
//   "another instance is polling" conflict — only sustained long-polls do.
//   We use timeout=1 throughout so grammY can keep its own loop running.
//
// Offset:
//   Each call uses our own offset cursor advanced past the largest update_id
//   we've seen. We initialize to the current high-water mark via offset=-1
//   so historical/replayed updates are skipped (we only care about clicks
//   issued *after* our approval card went out).
//
// Telegram does coalesce updates across callers — both grammY and us will
// see the same callback_query. That's fine: grammY-side processing (when
// it works) ends up calling plugin.approval.resolve through the loopback
// client, identical to ours. Whichever lands first wins; the second hits
// "approval already resolved" and harmlessly logs.

async function pollTelegramForOwnApprovalDecision({ approvalId, env, sendReq }) {
  const token = env.TG_BOT_TOKEN;
  const chatId = env.OPENCLAW_TURN_SOURCE_TO;
  if (!token || !chatId || !approvalId) return null;
  // Decision shortcodes: a1=allow-once, aa=allow-always, dn=deny. Match the
  // exact approvalId so we don't accidentally pick up stale clicks for some
  // other approval from chat history.
  const approvalIdEscaped = approvalId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matchPattern = new RegExp(`^cb:ad:${approvalIdEscaped}:(a1|aa|dn)$`);

  let offset = await initTelegramOffsetHighWater(token).catch(() => 0);
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url =
      `https://api.telegram.org/bot${token}/getUpdates?` +
      `offset=${offset}&timeout=1&allowed_updates=%5B%22callback_query%22%5D`;
    const res = await fetchWithTimeout(url, { method: "GET" }, 5_000);
    if (!res || !res.ok) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    for (const update of data.result) {
      if (typeof update.update_id === "number") {
        offset = Math.max(offset, update.update_id + 1);
      }
      const cb = update.callback_query;
      if (!cb || typeof cb.data !== "string") continue;
      const match = cb.data.match(matchPattern);
      if (!match) continue;
      const shortcode = match[1];
      const decision =
        shortcode === "a1" ? "allow-once" : shortcode === "aa" ? "allow-always" : "deny";
      // Ack the click so Telegram clears the loading spinner on the button.
      // Best-effort: even if this 404s due to query expiry, the resolve below
      // still completes the actual approval flow.
      ackTelegramCallback(token, cb.id).catch(() => {});
      // Forward decision through openclaw so waitDecision returns. If the
      // daemon already resolved via grammY, this fails with "approval already
      // resolved" — harmless, we just log and return.
      try {
        await sendReq("plugin.approval.resolve", { id: approvalId, decision });
      } catch (err) {
        process.stderr.write(`[perm-hook] direct-poll resolve forward: ${err?.message}\n`);
      }
      return decision;
    }
  }
  return null;
}

async function initTelegramOffsetHighWater(token) {
  // offset=-1 with timeout=0 returns just the most recent update (or empty);
  // we use its update_id + 1 as the floor so historical clicks don't trigger.
  const res = await fetchWithTimeout(
    `https://api.telegram.org/bot${token}/getUpdates?offset=-1&timeout=0`,
    { method: "GET" },
    3_000,
  );
  if (!res || !res.ok) return 0;
  const data = await res.json().catch(() => null);
  if (!data || !data.ok || !Array.isArray(data.result) || data.result.length === 0) return 0;
  const last = data.result[data.result.length - 1];
  return typeof last.update_id === "number" ? last.update_id + 1 : 0;
}

async function ackTelegramCallback(token, callbackQueryId) {
  await fetchWithTimeout(
    `https://api.telegram.org/bot${token}/answerCallbackQuery`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    },
    3_000,
  );
}

// ---- own approval card (replaces openclaw's telegram approval handler delivery) ----

function buildOwnApprovalCardText(input, approvalId) {
  const sessionShort = String(input.session_id || "").slice(0, 8) || "?";
  const toolName = input.tool_name || "tool";
  const cmd = formatToolCommandSnippet(input.tool_input);
  const lines = [`🛡 工具审批 · session \`${sessionShort}\``, `工具: \`${toolName}\``];
  if (cmd) {
    lines.push(`命令:\n\`\`\`\n${cmd}\n\`\`\``);
  }
  lines.push(`审批 id: \`${approvalId.slice(0, 8)}\``);
  return lines.join("\n");
}

function formatToolCommandSnippet(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  // Bash gets a nice single-line representation; other tools fall back to JSON.
  if (typeof toolInput.command === "string") {
    const c = toolInput.command.trim();
    return c.length > 400 ? `${c.slice(0, 400)}…` : c;
  }
  try {
    const json = JSON.stringify(toolInput);
    return json.length > 400 ? `${json.slice(0, 400)}…` : json;
  } catch {
    return "";
  }
}

async function sendOwnApprovalCard({ input, approvalId, env }) {
  const token = env.TG_BOT_TOKEN;
  const chatId = env.OPENCLAW_TURN_SOURCE_TO;
  if (!token || !chatId) {
    logPermHook(`sendOwnApprovalCard: missing token=${!!token} chatId=${!!chatId}`);
    return null;
  }
  const body = {
    chat_id: chatId,
    text: buildOwnApprovalCardText(input, approvalId),
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          // Decision shortcodes: a1=allow-once, aa=allow-always, dn=deny.
          // Handler lives in claude-bridge interactive.ts (action "ad").
          { text: "✅ 允许一次", callback_data: `cb:ad:${approvalId}:a1` },
          { text: "♾ 总是允许", callback_data: `cb:ad:${approvalId}:aa` },
        ],
        [{ text: "❌ 拒绝", callback_data: `cb:ad:${approvalId}:dn` }],
      ],
    },
  };
  const threadId = env.OPENCLAW_TURN_SOURCE_THREAD_ID;
  if (threadId && /^-?\d+$/.test(threadId)) {
    body.message_thread_id = Number(threadId);
  }
  // Send with retry: 3 attempts, short backoff. Reason: Clash-proxied
  // outbound to api.telegram.org occasionally drops (same root cause as
  // grammY's polling stalls). The card is the critical path — silent loss
  // here = user sees nothing for 110s then a denied tool. The retries are
  // bounded so we still fit inside the 110s budget even if all three fail.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetchWithTimeout(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      10_000,
    );
    if (!res) {
      logPermHook(`sendOwnApprovalCard attempt ${attempt}/3 network error`);
    } else if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      logPermHook(
        `sendOwnApprovalCard attempt ${attempt}/3 rc=${res.status} body=${errBody.slice(0, 200)}`,
      );
    } else {
      const data = await res.json().catch(() => null);
      if (data && data.ok && data.result) {
        logPermHook(`sendOwnApprovalCard ok msg=${data.result.message_id} (attempt ${attempt})`);
        return data.result.message_id;
      }
      logPermHook(
        `sendOwnApprovalCard attempt ${attempt}/3 unexpected payload: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  return null;
}

function logPermHook(msg) {
  process.stderr.write(`[perm-hook] ${msg}\n`);
}

async function editOwnApprovalCard({ messageId, decision, env }) {
  const token = env.TG_BOT_TOKEN;
  const chatId = env.OPENCLAW_TURN_SOURCE_TO;
  if (!token || !chatId || !messageId) return;
  const verdict = formatDecisionVerdict(decision);
  await fetchWithTimeout(
    `https://api.telegram.org/bot${token}/editMessageText`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: verdict,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [] },
      }),
    },
    5_000,
  ).catch(() => {});
}

function formatDecisionVerdict(decision) {
  if (decision === "allow-once") return "✅ 已允许（仅此次）";
  if (decision === "allow-always") return "♾ 已允许（之后总是允许）";
  if (decision === "deny") return "❌ 已拒绝";
  return "⏱ 审批超时（按拒绝处理）";
}

// ---- follow-marker polling (matches openclaw/extensions/claude-bridge/src/follow-marker.ts) ----

function isFollowingSession(chatId, sessionId) {
  try {
    return fs.existsSync(path.join(FOLLOW_MARKER_DIR, `${chatId}-${sessionId}`));
  } catch {
    return false;
  }
}

async function waitForFollowMarker(chatId, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isFollowingSession(chatId, sessionId)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, NUDGE_POLL_INTERVAL_MS));
  }
  return false;
}

// ---- inline helpers (keep in sync with src/perm-hook-decision.ts) ----

function buildApprovalRequestParams(input, env, approvalTimeoutMs) {
  const description = formatToolDescription(input.tool_name, input.tool_input, input.session_id);
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

function formatToolDescription(toolName, toolInput, sessionId) {
  const lines = [`Tool: ${toolName || "?"}`];
  if (typeof sessionId === "string" && sessionId.length > 0) {
    lines.push(`Session: ${sessionId.slice(0, 8)}`);
  }
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

// ---- companion message (telegram-only) ----

async function sendApprovalCompanion(input, env) {
  const token = env.TG_BOT_TOKEN;
  const chatId = env.OPENCLAW_TURN_SOURCE_TO;
  const sessionId = input.session_id;
  if (!token || !chatId || !sessionId || env.OPENCLAW_TURN_SOURCE_CHANNEL !== "telegram") {
    return null;
  }
  const sidShort = String(sessionId).slice(0, 8);
  const toolName = input.tool_name || "tool";
  const body = {
    chat_id: chatId,
    text: `🛡 session \`${sidShort}\` 等待审批：${toolName}\n点 [👁 进入] 进入会话后会看到工具卡片`,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "👁 进入 session",
            // Matches ACTION.enterAndFollow in tab-manager-ui.ts; handler
            // lives in claude-bridge interactive.ts.
            callback_data: `cb:ef:${sessionId}`,
          },
        ],
      ],
    },
  };
  const threadId = env.OPENCLAW_TURN_SOURCE_THREAD_ID;
  if (threadId && /^-?\d+$/.test(threadId)) {
    body.message_thread_id = Number(threadId);
  }
  const res = await fetchWithTimeout(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    10_000,
  );
  if (!res || !res.ok) {
    return null;
  }
  const data = await res.json().catch(() => null);
  if (data && data.ok && data.result && data.result.message_id) {
    return data.result.message_id;
  }
  return null;
}

async function clearApprovalCompanionButtons(messageId, env) {
  const token = env.TG_BOT_TOKEN;
  const chatId = env.OPENCLAW_TURN_SOURCE_TO;
  if (!token || !chatId || !messageId) {
    return;
  }
  // editMessageReplyMarkup with empty inline_keyboard removes buttons but
  // keeps the text — user still sees "session X 等待审批" with no stale [👁].
  await fetchWithTimeout(
    `https://api.telegram.org/bot${token}/editMessageReplyMarkup`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      }),
    },
    5_000,
  ).catch(() => {});
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const signal = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  try {
    return await fetch(url, signal ? { ...init, signal } : init);
  } catch {
    return null;
  }
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

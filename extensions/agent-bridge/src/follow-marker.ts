// Filesystem signal between the bot daemon and the perm-hook child process.
//
// Problem: perm-hook.cjs (spawned per tool call) needs to know whether the
// user has "entered" the agent session in Telegram so it can decide between:
//   - send a `[👁 进入 session]` nudge first, wait for user, THEN call
//     plugin.approval.request (and have the standard openclaw card appear
//     in the now-followed stream)
//   - skip the nudge and call plugin.approval.request immediately when the
//     user is already following the session
//
// Since perm-hook is a separate Node process, in-memory state in the daemon
// is invisible. The simplest signal that survives the process boundary is a
// file in a well-known directory. Daemon touches/removes a marker around
// every follow lifecycle event; perm-hook polls.
//
// Path: /tmp/openclaw/follow-markers/<chatId>-<sessionId>  (kept in sync with
// the openclaw gateway log path convention).
//
// Single-user / single-machine assumption. Multi-tenant would need per-user
// scoping.

import fs from "node:fs";
import path from "node:path";
import { sendBotMessage } from "./telegram-bot-api.js";

const MARKER_DIR = "/tmp/openclaw/follow-markers";

function markerPath(chatId: string, sessionId: string): string {
  // sessionId is a UUID; chatId is a numeric string. Both safe in filenames.
  return path.join(MARKER_DIR, `${chatId}-${sessionId}`);
}

export function writeFollowMarker(chatId: string, sessionId: string): void {
  try {
    fs.mkdirSync(MARKER_DIR, { recursive: true });
    fs.writeFileSync(markerPath(chatId, sessionId), "", "utf8");
  } catch (err) {
    process.stderr.write(`[follow-marker] write failed: ${String(err)}\n`);
  }
}

export function clearFollowMarker(chatId: string, sessionId: string): void {
  try {
    fs.unlinkSync(markerPath(chatId, sessionId));
  } catch {
    // not present is fine
  }
}

/**
 * `telegram:5028451986` → `5028451986`. perm-hook reads the bare chatId from
 * OPENCLAW_TURN_SOURCE_TO; chat-state uses the prefixed form. Keep them
 * aligned here.
 */
export function chatIdFromChatKey(chatKey: string): string {
  const colon = chatKey.indexOf(":");
  return colon === -1 ? chatKey : chatKey.slice(colon + 1);
}

/**
 * On daemon restart the in-memory follow loops are gone, but the filesystem
 * markers still live (perm-hook would observe them and think the user is in
 * follow). Call at plugin init: scan the dir, notify each affected chat that
 * its stream stopped, then delete the marker so perm-hook is back to "no
 * follow" state. Best-effort — errors are swallowed.
 */
export async function notifyAndClearStaleFollowMarkers(opts: {
  tgBotToken: string | undefined;
}): Promise<number> {
  const token = opts.tgBotToken?.trim();
  let entries: string[];
  try {
    entries = fs.readdirSync(MARKER_DIR);
  } catch {
    return 0; // dir doesn't exist yet — nothing to clean
  }

  let cleared = 0;
  for (const name of entries) {
    // Filename shape: `<chatId>-<sessionId>` where sessionId is a UUID with
    // 4 hyphens. The chatId portion is everything before the first hyphen.
    const dash = name.indexOf("-");
    if (dash <= 0) continue;
    const chatId = name.slice(0, dash);
    const sessionId = name.slice(dash + 1);

    if (token && /^-?\d+$/.test(chatId)) {
      // Best-effort notice; doesn't block cleanup if it fails.
      void sendStaleFollowNotice(token, chatId, sessionId).catch(() => {});
    }
    try {
      fs.unlinkSync(path.join(MARKER_DIR, name));
      cleared++;
    } catch {
      // best-effort
    }
  }
  return cleared;
}

async function sendStaleFollowNotice(
  token: string,
  chatId: string,
  sessionId: string,
): Promise<void> {
  // Always lands in the user's DM (the chat that originally issued /agent),
  // never inside a forum topic — a stale-restart notice belongs where the
  // user first sees the bot, not buried in a per-project thread they may
  // not have open.
  const sidShort = sessionId.slice(0, 8);
  await sendBotMessage({
    botToken: token,
    chatId,
    text:
      `⏹ 推流已关闭（daemon 重启）\n` +
      `上次在 session \`${sidShort}\`。发 /agent 看面板重新选 session。`,
    parseMode: "Markdown",
    timeoutMs: 8_000,
  });
}

// Filesystem signal between the bot daemon and the perm-hook child process.
//
// Problem: perm-hook.cjs (spawned per tool call) needs to know whether the
// user has "entered" the claude session in Telegram so it can decide between:
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

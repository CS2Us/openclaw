// Build the "recent local sessions" list shown in the tab manager: every
// jsonl in the cwd's ~/.claude/projects/<encoded>/ directory that isn't
// already pinned by a chat-state tab. Sorted by mtime desc, capped at N.
//
// Lives in its own file so:
//   - tab-manager-ui.ts stays pure (no fs)
//   - command.ts and interactive.ts share one source of truth
//   - it's easy to unit-test by stubbing session-discovery
//
// Self-exclusion: if a tab already pins a sessionId, that session is hidden
// from the import list. The user wouldn't expect to "import" a tab they
// already have.

import type { ChatState } from "./chat-state.js";
import { listSessionFiles, readSessionInfo } from "./session-discovery.js";
import type { LocalSessionSummary } from "./tab-manager-ui.js";

const DEFAULT_LIMIT = 5;

export function gatherRecentLocalSessions(params: {
  state: ChatState;
  cwd: string;
  limit?: number;
}): LocalSessionSummary[] {
  const limit = params.limit ?? DEFAULT_LIMIT;
  const taken = new Set<string>();
  for (const t of params.state.tabs) {
    if (t.sessionId) {
      taken.add(t.sessionId);
    }
  }
  const out: LocalSessionSummary[] = [];
  for (const f of listSessionFiles(params.cwd)) {
    if (out.length >= limit) {
      break;
    }
    if (taken.has(f.sessionId)) {
      continue;
    }
    const info = readSessionInfo(f.jsonlPath);
    out.push({
      sessionId: f.sessionId,
      preview: info.preview,
      eventCount: info.eventCount,
    });
  }
  return out;
}

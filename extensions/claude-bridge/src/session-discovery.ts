// Discover claude session jsonl files for cross-process / cross-device session
// adoption (`/claude session` + `/claude continue` Telegram sub-commands).
//
// claude stores per-cwd sessions at `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`
// where encoded-cwd replaces "/" with "-". Each line in the jsonl is a JSON
// event (user / assistant / system / summary / ...). When a turn appends, the
// file's mtime advances. Same jsonl can be resumed by `claude --resume <uuid>`
// from any process / shell, so chat-state can adopt a local-CLI session id and
// the next bridge turn will continue with the user's terminal context loaded.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SessionFileEntry = {
  sessionId: string;
  jsonlPath: string;
  mtimeMs: number;
};

export type SessionInfo = SessionFileEntry & {
  /** Number of newline-delimited events in the jsonl. */
  eventCount: number;
  /** Timestamp of the most recent line carrying a `timestamp` field; null if none parseable. */
  lastEventMs: number | null;
  /** Truncated preview of the last user message, useful for confirmation UX. */
  preview: string | null;
};

export function encodeCwd(cwd: string): string {
  return cwd.replaceAll("/", "-");
}

export function sessionsDir(cwd: string, home: string = os.homedir()): string {
  return path.join(home, ".claude", "projects", encodeCwd(cwd));
}

export function listSessionFiles(cwd: string, home: string = os.homedir()): SessionFileEntry[] {
  const dir = sessionsDir(cwd, home);
  if (!fs.existsSync(dir)) {
    return [];
  }
  const entries: SessionFileEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const jsonlPath = path.join(dir, name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(jsonlPath).mtimeMs;
    } catch {
      continue;
    }
    entries.push({
      sessionId: name.replace(/\.jsonl$/, ""),
      jsonlPath,
      mtimeMs,
    });
  }
  return entries.toSorted((a, b) => b.mtimeMs - a.mtimeMs);
}

export function readSessionInfo(jsonlPath: string): {
  eventCount: number;
  lastEventMs: number | null;
  preview: string | null;
} {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, "utf8");
  } catch {
    return { eventCount: 0, lastEventMs: null, preview: null };
  }
  const lines = raw.split("\n").filter((line) => line.length > 0);

  // Preview = the *first* substantive user prompt (not the last). The first
  // message identifies what the session is "about" and is stable across
  // continuations. We strip IDE / slash-command wrapper tags
  // (`<ide_opened_file>…</ide_opened_file>`, `<command-message>…</command-message>`)
  // so the preview shows the user's actual text.
  let preview: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i] ?? "");
    } catch {
      continue;
    }
    if (!isObject(parsed) || parsed["type"] !== "user") {
      continue;
    }
    const text = stripWrapperTags(extractUserText(parsed)).trim();
    if (!text) {
      continue;
    }
    preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    break;
  }

  // lastEventMs: the most recent parseable timestamp on any event.
  let lastEventMs: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i] ?? "");
      if (isObject(parsed) && typeof parsed["timestamp"] === "string") {
        const t = Date.parse(parsed["timestamp"]);
        if (Number.isFinite(t)) {
          lastEventMs = t;
          break;
        }
      }
    } catch {
      // skip bad lines
    }
  }

  return { eventCount: lines.length, lastEventMs, preview };
}

/**
 * Drop one or more leading `<tag>...</tag>` wrappers that IDE / Claude Code
 * inject before the user's actual text. Keeps simple `<` characters that
 * appear inside a real user prompt (e.g. "use `<` for ...") untouched, since
 * those wouldn't match the strict `<tag>` pattern.
 */
function stripWrapperTags(text: string): string {
  let out = text;
  // Iterate so multiple stacked wrappers (rare but possible) all get stripped.
  for (let i = 0; i < 4; i++) {
    const m = /^\s*<([a-zA-Z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>\s*/m.exec(out);
    if (!m) {
      break;
    }
    out = out.slice(m[0].length);
  }
  return out;
}

export function findMostRecentSession(opts: {
  cwd: string;
  excludeSessionIds?: ReadonlySet<string>;
  home?: string;
}): SessionInfo | undefined {
  for (const entry of listSessionFiles(opts.cwd, opts.home)) {
    if (opts.excludeSessionIds?.has(entry.sessionId)) {
      continue;
    }
    return { ...entry, ...readSessionInfo(entry.jsonlPath) };
  }
  return undefined;
}

function extractUserText(event: Record<string, unknown>): string {
  const message = event["message"];
  if (!isObject(message)) {
    return "";
  }
  const content = message["content"];
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!isObject(block)) {
      continue;
    }
    if (typeof block["text"] === "string") {
      parts.push(block["text"]);
    } else if (typeof block["content"] === "string") {
      parts.push(block["content"]);
    }
  }
  return parts.join(" ").trim();
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

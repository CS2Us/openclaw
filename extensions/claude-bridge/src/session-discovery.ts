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
  let lastEventMs: number | null = null;
  let preview: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    if (!isObject(parsed)) {
      continue;
    }
    if (lastEventMs === null && typeof parsed["timestamp"] === "string") {
      const t = Date.parse(parsed["timestamp"]);
      if (Number.isFinite(t)) {
        lastEventMs = t;
      }
    }
    if (preview === null && parsed["type"] === "user") {
      const text = extractUserText(parsed);
      if (text) {
        preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
      }
    }
    if (lastEventMs !== null && preview !== null) {
      break;
    }
  }
  return { eventCount: lines.length, lastEventMs, preview };
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

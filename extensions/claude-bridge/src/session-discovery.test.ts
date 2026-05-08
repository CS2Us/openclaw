import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodeCwd,
  findMostRecentSession,
  listSessionFiles,
  readSessionInfo,
  sessionsDir,
} from "./session-discovery.js";

let tmpHome: string;
let cwd: string;

function writeJsonl(home: string, cwd: string, sessionId: string, events: object[]) {
  const dir = sessionsDir(cwd, home);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return file;
}

function setMtime(file: string, mtimeSec: number) {
  fs.utimesSync(file, mtimeSec, mtimeSec);
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-discovery-"));
  cwd = "/Users/test/project-x";
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("encodeCwd", () => {
  it("replaces all forward slashes with dashes", () => {
    expect(encodeCwd("/Users/guoyiyuan/Desktop/telegram")).toBe(
      "-Users-guoyiyuan-Desktop-telegram",
    );
  });
});

describe("listSessionFiles", () => {
  it("returns empty when sessions dir does not exist", () => {
    expect(listSessionFiles(cwd, tmpHome)).toEqual([]);
  });

  it("ignores non-jsonl files", () => {
    writeJsonl(tmpHome, cwd, "abc", [{ type: "user" }]);
    const dir = sessionsDir(cwd, tmpHome);
    fs.writeFileSync(path.join(dir, "stray.txt"), "noise", "utf8");
    fs.writeFileSync(path.join(dir, "backup.jsonl.bak"), "noise", "utf8");
    const list = listSessionFiles(cwd, tmpHome);
    expect(list.map((e) => e.sessionId)).toEqual(["abc"]);
  });

  it("sorts entries by mtime descending", () => {
    const a = writeJsonl(tmpHome, cwd, "old", [{ type: "user" }]);
    const b = writeJsonl(tmpHome, cwd, "mid", [{ type: "user" }]);
    const c = writeJsonl(tmpHome, cwd, "new", [{ type: "user" }]);
    setMtime(a, 1_700_000_000);
    setMtime(b, 1_700_000_500);
    setMtime(c, 1_700_001_000);
    expect(listSessionFiles(cwd, tmpHome).map((e) => e.sessionId)).toEqual(["new", "mid", "old"]);
  });
});

describe("readSessionInfo", () => {
  it("counts events and finds last timestamp + last user preview", () => {
    const file = writeJsonl(tmpHome, cwd, "s1", [
      { type: "user", message: { content: "first" }, timestamp: "2026-05-01T00:00:00Z" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
        timestamp: "2026-05-01T00:00:05Z",
      },
      {
        type: "user",
        message: { content: [{ type: "text", text: "second message" }] },
        timestamp: "2026-05-01T00:00:10Z",
      },
    ]);
    const info = readSessionInfo(file);
    expect(info.eventCount).toBe(3);
    expect(info.lastEventMs).toBe(Date.parse("2026-05-01T00:00:10Z"));
    expect(info.preview).toBe("second message");
  });

  it("truncates long previews at 80 chars with ellipsis", () => {
    const long =
      "请帮我把 chromite agents-commerce phase 1J 的 Postgres store 接到 server HTTP 入口".repeat(
        2,
      );
    const file = writeJsonl(tmpHome, cwd, "s2", [{ type: "user", message: { content: long } }]);
    const info = readSessionInfo(file);
    expect(info.preview).toMatch(/…$/);
    expect(info.preview!.length).toBeLessThanOrEqual(81);
  });

  it("skips malformed lines and keeps reading further back", () => {
    const dir = sessionsDir(cwd, tmpHome);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "broken.jsonl");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "user", message: { content: "first" } }),
        "not json at all",
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "ok" }] },
          timestamp: "2026-05-01T00:00:30Z",
        }),
      ].join("\n"),
      "utf8",
    );
    const info = readSessionInfo(file);
    expect(info.eventCount).toBe(3);
    expect(info.lastEventMs).toBe(Date.parse("2026-05-01T00:00:30Z"));
    expect(info.preview).toBe("first");
  });

  it("returns empty info for non-existent file", () => {
    const info = readSessionInfo("/no/such/path.jsonl");
    expect(info).toEqual({ eventCount: 0, lastEventMs: null, preview: null });
  });
});

describe("findMostRecentSession", () => {
  it("returns the most-recently-modified session by default", () => {
    const a = writeJsonl(tmpHome, cwd, "old", [{ type: "user", message: { content: "a" } }]);
    const b = writeJsonl(tmpHome, cwd, "newer", [{ type: "user", message: { content: "b" } }]);
    setMtime(a, 1_700_000_000);
    setMtime(b, 1_700_001_000);
    const recent = findMostRecentSession({ cwd, home: tmpHome });
    expect(recent?.sessionId).toBe("newer");
    expect(recent?.preview).toBe("b");
  });

  it("respects excludeSessionIds and falls through to next most recent", () => {
    const a = writeJsonl(tmpHome, cwd, "older", [
      { type: "user", message: { content: "older-content" } },
    ]);
    const b = writeJsonl(tmpHome, cwd, "newest", [
      { type: "user", message: { content: "newest-content" } },
    ]);
    setMtime(a, 1_700_000_000);
    setMtime(b, 1_700_001_000);
    const recent = findMostRecentSession({
      cwd,
      home: tmpHome,
      excludeSessionIds: new Set(["newest"]),
    });
    expect(recent?.sessionId).toBe("older");
  });

  it("returns undefined when dir is empty (or no candidates after exclusion)", () => {
    expect(findMostRecentSession({ cwd, home: tmpHome })).toBeUndefined();
    writeJsonl(tmpHome, cwd, "only-one", [{ type: "user", message: { content: "x" } }]);
    expect(
      findMostRecentSession({
        cwd,
        home: tmpHome,
        excludeSessionIds: new Set(["only-one"]),
      }),
    ).toBeUndefined();
  });
});

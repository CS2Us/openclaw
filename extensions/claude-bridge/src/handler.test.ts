import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildClaudeSpawnArgs,
  buildClaudeSpawnEnv,
  createStreamJsonAggregator,
  truncate,
} from "./handler.js";

describe("createStreamJsonAggregator", () => {
  it("captures session_id from the first system event", () => {
    const agg = createStreamJsonAggregator();
    agg.feedLine(JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123" }));
    expect(agg.finalize().sessionId).toBe("abc-123");
  });

  it("ignores subsequent system session_id once captured", () => {
    const agg = createStreamJsonAggregator();
    agg.feedLine(JSON.stringify({ type: "system", session_id: "first" }));
    agg.feedLine(JSON.stringify({ type: "system", session_id: "second" }));
    expect(agg.finalize().sessionId).toBe("first");
  });

  it("accumulates text content from assistant blocks in order", () => {
    const agg = createStreamJsonAggregator();
    agg.feedLine(JSON.stringify({ type: "system", session_id: "s" }));
    agg.feedLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello, " }] },
      }),
    );
    agg.feedLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "world" },
            { type: "text", text: "!" },
          ],
        },
      }),
    );
    expect(agg.finalize().text).toBe("Hello, world!");
  });

  it("skips non-text content blocks (tool_use, thinking, etc.)", () => {
    const agg = createStreamJsonAggregator();
    agg.feedLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "internal" },
            { type: "text", text: "visible" },
            { type: "tool_use", name: "Read", input: { path: "/etc/passwd" } },
          ],
        },
      }),
    );
    expect(agg.finalize().text).toBe("visible");
  });

  it("ignores unrelated event types (result, user tool_result echoes)", () => {
    const agg = createStreamJsonAggregator();
    agg.feedLine(
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", content: "ok" }] },
      }),
    );
    agg.feedLine(JSON.stringify({ type: "result", subtype: "success", duration_ms: 42 }));
    expect(agg.finalize().text).toBe("");
    expect(agg.finalize().sessionId).toBeNull();
  });

  it("survives malformed JSON lines (drop and continue)", () => {
    const agg = createStreamJsonAggregator();
    agg.feedLine("not json at all");
    agg.feedLine("");
    agg.feedLine(JSON.stringify({ type: "system", session_id: "after-noise" }));
    agg.feedLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      }),
    );
    expect(agg.finalize().sessionId).toBe("after-noise");
    expect(agg.finalize().text).toBe("ok");
  });

  it("ignores assistant events without a content array", () => {
    const agg = createStreamJsonAggregator();
    agg.feedLine(JSON.stringify({ type: "assistant", message: {} }));
    agg.feedLine(JSON.stringify({ type: "assistant", message: { content: "nope" } }));
    expect(agg.finalize().text).toBe("");
  });
});

describe("truncate", () => {
  it("returns text unchanged when within the limit", () => {
    expect(truncate("hi", 10)).toBe("hi");
  });

  it("appends a suffix indicating dropped chars when over the limit", () => {
    expect(truncate("abcdef", 3)).toBe("abc\n\n…(truncated, 3 chars dropped)");
  });
});

describe("buildClaudeSpawnArgs", () => {
  const baseParams = {
    bin: "claude",
    cwd: "/tmp/x",
    allowedTools: "Read,Edit",
    timeoutMs: 30_000,
    prompt: "hello",
  };

  const originalPermissionMode = process.env.CLAUDE_BRIDGE_PERMISSION_MODE;
  beforeEach(() => {
    delete process.env.CLAUDE_BRIDGE_PERMISSION_MODE;
  });
  afterEach(() => {
    if (originalPermissionMode === undefined) {
      delete process.env.CLAUDE_BRIDGE_PERMISSION_MODE;
    } else {
      process.env.CLAUDE_BRIDGE_PERMISSION_MODE = originalPermissionMode;
    }
  });

  it("emits the minimal stream-json+verbose invocation", () => {
    const args = buildClaudeSpawnArgs(baseParams);
    expect(args).toEqual([
      "-p",
      "hello",
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowed-tools",
      "Read,Edit",
    ]);
  });

  it("appends --permission-mode <mode> when CLAUDE_BRIDGE_PERMISSION_MODE is set", () => {
    process.env.CLAUDE_BRIDGE_PERMISSION_MODE = "auto";
    const args = buildClaudeSpawnArgs(baseParams);
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
  });

  it("omits --permission-mode when the env var is empty or only whitespace", () => {
    process.env.CLAUDE_BRIDGE_PERMISSION_MODE = "   ";
    const args = buildClaudeSpawnArgs(baseParams);
    expect(args).not.toContain("--permission-mode");
  });

  it("appends --resume <id> when resumeSessionId is set", () => {
    const args = buildClaudeSpawnArgs({ ...baseParams, resumeSessionId: "sid-7" });
    expect(args.slice(-2)).toEqual(["--resume", "sid-7"]);
  });

  it("does not append --resume when resumeSessionId is null/undefined/empty", () => {
    expect(buildClaudeSpawnArgs({ ...baseParams, resumeSessionId: null })).not.toContain(
      "--resume",
    );
    expect(buildClaudeSpawnArgs({ ...baseParams, resumeSessionId: undefined })).not.toContain(
      "--resume",
    );
    expect(buildClaudeSpawnArgs({ ...baseParams, resumeSessionId: "" })).not.toContain("--resume");
  });

  it("emits a PreToolUse hook --settings + --include-hook-events when permHookScriptPath set", () => {
    const args = buildClaudeSpawnArgs({
      ...baseParams,
      permHookScriptPath: "/abs/path/to/perm-hook.cjs",
    });
    expect(args).toContain("--settings");
    expect(args).toContain("--include-hook-events");
    const settingsIdx = args.indexOf("--settings");
    const settingsJson = args[settingsIdx + 1];
    expect(settingsJson).toBeDefined();
    const parsed = JSON.parse(settingsJson!);
    expect(parsed).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "/abs/path/to/perm-hook.cjs" }],
          },
        ],
      },
    });
  });

  it("does not add --settings when permHookScriptPath is empty", () => {
    expect(buildClaudeSpawnArgs({ ...baseParams, permHookScriptPath: "" })).not.toContain(
      "--settings",
    );
    expect(buildClaudeSpawnArgs({ ...baseParams, permHookScriptPath: null })).not.toContain(
      "--settings",
    );
  });

  it("composes resume + hook flags together in deterministic order", () => {
    const args = buildClaudeSpawnArgs({
      ...baseParams,
      resumeSessionId: "sid-3",
      permHookScriptPath: "/abs/perm.cjs",
    });
    const resumeIdx = args.indexOf("--resume");
    const settingsIdx = args.indexOf("--settings");
    expect(resumeIdx).toBeGreaterThan(0);
    expect(settingsIdx).toBeGreaterThan(resumeIdx);
  });
});

describe("buildClaudeSpawnEnv", () => {
  it("returns the base env unchanged when permHookEnv is absent", () => {
    const base = { FOO: "1", BAR: "2" };
    expect(buildClaudeSpawnEnv({}, base)).toBe(base);
    expect(buildClaudeSpawnEnv({ permHookEnv: null }, base)).toBe(base);
  });

  it("merges permHookEnv on top of the base env", () => {
    const base = { FOO: "1", BAR: "2" };
    const merged = buildClaudeSpawnEnv(
      { permHookEnv: { OPENCLAW_GATEWAY_URL: "ws://x", BAR: "overridden" } },
      base,
    );
    expect(merged).toEqual({
      FOO: "1",
      BAR: "overridden",
      OPENCLAW_GATEWAY_URL: "ws://x",
    });
    // base must not be mutated
    expect(base.BAR).toBe("2");
  });
});

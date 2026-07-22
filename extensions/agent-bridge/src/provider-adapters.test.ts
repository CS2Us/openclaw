import { afterEach, describe, expect, it } from "vitest";
import {
  AgentCapabilityError,
  buildProviderSpawnSpec,
  parseCodexJsonl,
  providerCapabilities,
} from "./provider-adapters.js";

const base = {
  prompt: "review this",
  allowedTools: "Read,Grep",
} as const;

const originalCanonicalMode = process.env.OPENCLAW_AGENT_BRIDGE_PERMISSION_MODE;
const originalLegacyMode = process.env.CLAUDE_BRIDGE_PERMISSION_MODE;

afterEach(() => {
  if (originalCanonicalMode === undefined) {
    delete process.env.OPENCLAW_AGENT_BRIDGE_PERMISSION_MODE;
  } else {
    process.env.OPENCLAW_AGENT_BRIDGE_PERMISSION_MODE = originalCanonicalMode;
  }
  if (originalLegacyMode === undefined) {
    delete process.env.CLAUDE_BRIDGE_PERMISSION_MODE;
  } else {
    process.env.CLAUDE_BRIDGE_PERMISSION_MODE = originalLegacyMode;
  }
});

describe("provider adapter boundary", () => {
  it("keeps Claude stream/resume/hook flags inside the Claude adapter", () => {
    const spec = buildProviderSpawnSpec({
      ...base,
      provider: "claude",
      resumeSessionId: "sid-1",
      permHookScriptPath: "/abs/hook.cjs",
    });
    expect(spec.args).toContain("stream-json");
    expect(spec.args).toContain("--resume");
    expect(spec.args).toContain("--settings");
    expect(spec.args).toContain("--include-hook-events");
  });

  it("builds Codex one-shot argv without Claude-only flags", () => {
    const spec = buildProviderSpawnSpec({
      ...base,
      provider: "codex",
      model: "gpt-5.5",
      reasoningEffort: "high",
    });
    expect(spec.args).toEqual([
      "exec",
      "--model",
      "gpt-5.5",
      "-c",
      'model_reasoning_effort="high"',
      "--sandbox",
      "read-only",
      "--json",
      "-",
    ]);
    expect(spec.stdin).toBe("review this");
    expect(spec.args).not.toContain("--settings");
    expect(spec.args).not.toContain("--include-hook-events");
  });

  it("builds Gemini one-shot argv without Claude-only flags", () => {
    const spec = buildProviderSpawnSpec({ ...base, provider: "gemini" });
    expect(spec.args).toContain("--print");
    expect(spec.args).not.toContain("--resume");
    expect(spec.args).not.toContain("--settings");
  });

  it("fails before spawn when a one-shot provider is asked to resume or approve tools", () => {
    expect(() =>
      buildProviderSpawnSpec({ ...base, provider: "codex", resumeSessionId: "sid" }),
    ).toThrow(AgentCapabilityError);
    expect(() =>
      buildProviderSpawnSpec({ ...base, provider: "gemini", permHookScriptPath: "/hook" }),
    ).toThrow(/tool_approval/);
  });

  it("advertises unattended allow-list support only for the verified Claude adapter", () => {
    expect(providerCapabilities("claude").has("unattended_allowlist")).toBe(true);
    expect(providerCapabilities("codex").has("unattended_allowlist")).toBe(false);
    expect(providerCapabilities("gemini").has("unattended_allowlist")).toBe(false);
  });

  it("gives canonical permission env precedence over the legacy fallback", () => {
    process.env.OPENCLAW_AGENT_BRIDGE_PERMISSION_MODE = "default";
    process.env.CLAUDE_BRIDGE_PERMISSION_MODE = "bypassPermissions";
    const spec = buildProviderSpawnSpec({ ...base, provider: "claude" });
    expect(spec.args[spec.args.indexOf("--permission-mode") + 1]).toBe("default");
  });

  it("parses Codex JSONL without treating private session state as handback identity", () => {
    const parsed = parseCodexJsonl(
      '{"thread_id":"thread-1"}\n' +
        '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n',
    );
    expect(parsed).toEqual({ text: "done", sessionId: "thread-1" });
  });
});

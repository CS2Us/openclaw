import { describe, expect, it } from "vitest";
import { buildPermHookEnv } from "./perm-hook-spawn.js";

describe("buildPermHookEnv", () => {
  it("populates the standard OPENCLAW_TURN_* env from a Telegram DM", () => {
    const env = buildPermHookEnv({
      gatewayUrl: "ws://127.0.0.1:18789",
      gatewayPassword: "secret123",
      routing: {
        channel: "telegram",
        chatId: "12345",
        agentId: "agent-A",
        accountId: "acct-1",
      },
    });
    expect(env).toEqual({
      OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
      OPENCLAW_GATEWAY_PASSWORD: "secret123",
      OPENCLAW_TURN_AGENT_ID: "agent-A",
      OPENCLAW_TURN_SESSION_KEY: "telegram:12345",
      OPENCLAW_TURN_SOURCE_CHANNEL: "telegram",
      OPENCLAW_TURN_SOURCE_TO: "12345",
      OPENCLAW_TURN_SOURCE_ACCOUNT_ID: "acct-1",
    });
    expect("OPENCLAW_TURN_SOURCE_THREAD_ID" in env).toBe(false);
  });

  it("honors explicit sessionKey and threadId when provided", () => {
    const env = buildPermHookEnv({
      gatewayPassword: "x",
      routing: {
        channel: "telegram",
        chatId: "1",
        sessionKey: "custom-session-key",
        threadId: 77,
      },
    });
    expect(env.OPENCLAW_TURN_SESSION_KEY).toBe("custom-session-key");
    expect(env.OPENCLAW_TURN_SOURCE_THREAD_ID).toBe("77");
  });

  it("defaults agentId / accountId when caller doesn't set them", () => {
    const env = buildPermHookEnv({
      gatewayPassword: "x",
      routing: { channel: "telegram", chatId: "1" },
    });
    expect(env.OPENCLAW_TURN_AGENT_ID).toBe("claude-bridge");
    expect(env.OPENCLAW_TURN_SOURCE_ACCOUNT_ID).toBe("default");
  });

  it("falls back to ws://127.0.0.1:18789 when gatewayUrl is absent", () => {
    const env = buildPermHookEnv({
      gatewayPassword: "x",
      routing: { channel: "telegram", chatId: "1" },
    });
    expect(env.OPENCLAW_GATEWAY_URL).toBe("ws://127.0.0.1:18789");
  });

  it("omits THREAD_ID env when threadId is empty/null/undefined", () => {
    expect(
      buildPermHookEnv({
        gatewayPassword: "x",
        routing: { channel: "telegram", chatId: "1", threadId: undefined },
      }).OPENCLAW_TURN_SOURCE_THREAD_ID,
    ).toBeUndefined();
    expect(
      buildPermHookEnv({
        gatewayPassword: "x",
        routing: { channel: "telegram", chatId: "1", threadId: "" },
      }).OPENCLAW_TURN_SOURCE_THREAD_ID,
    ).toBeUndefined();
  });
});

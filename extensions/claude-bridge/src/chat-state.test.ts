import { beforeEach, describe, expect, it } from "vitest";
import {
  chatStateKey,
  clearAllChatStatesForTesting,
  getOrCreateChatState,
  resetChatState,
  updateChatStateAfterTurn,
} from "./chat-state.js";

beforeEach(() => {
  clearAllChatStatesForTesting();
});

describe("chatStateKey", () => {
  it("composes channel + chat id with a colon separator", () => {
    expect(chatStateKey("telegram", "12345")).toBe("telegram:12345");
  });
});

describe("getOrCreateChatState", () => {
  it("starts with sessionId=null on first read", () => {
    const state = getOrCreateChatState("telegram:1");
    expect(state.sessionId).toBeNull();
    expect(state.lastUsedAt).toBeGreaterThan(0);
  });

  it("returns the same instance on subsequent reads (so writes stick)", () => {
    const a = getOrCreateChatState("telegram:1");
    a.sessionId = "abc";
    const b = getOrCreateChatState("telegram:1");
    expect(b.sessionId).toBe("abc");
  });

  it("isolates state across distinct keys", () => {
    const a = getOrCreateChatState("telegram:1");
    a.sessionId = "abc";
    const b = getOrCreateChatState("telegram:2");
    expect(b.sessionId).toBeNull();
  });
});

describe("updateChatStateAfterTurn", () => {
  it("writes the new sessionId when present", () => {
    updateChatStateAfterTurn("telegram:1", "session-xyz");
    expect(getOrCreateChatState("telegram:1").sessionId).toBe("session-xyz");
  });

  it("preserves the existing sessionId when the new one is null", () => {
    updateChatStateAfterTurn("telegram:1", "session-xyz");
    updateChatStateAfterTurn("telegram:1", null);
    expect(getOrCreateChatState("telegram:1").sessionId).toBe("session-xyz");
  });

  it("bumps lastUsedAt", async () => {
    const before = getOrCreateChatState("telegram:1").lastUsedAt;
    await new Promise((r) => setTimeout(r, 5));
    updateChatStateAfterTurn("telegram:1", "session-xyz");
    expect(getOrCreateChatState("telegram:1").lastUsedAt).toBeGreaterThan(before);
  });
});

describe("resetChatState", () => {
  it("clears sessionId back to null", () => {
    updateChatStateAfterTurn("telegram:1", "to-be-killed");
    resetChatState("telegram:1");
    expect(getOrCreateChatState("telegram:1").sessionId).toBeNull();
  });

  it("creates an empty state if the key was never used", () => {
    resetChatState("telegram:fresh");
    expect(getOrCreateChatState("telegram:fresh").sessionId).toBeNull();
  });
});

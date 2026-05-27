import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMappingKey,
  buildTopicName,
  hydrateTopicMappingsFromStore,
  readForumGroupIdFromEnv,
  readTopicModeFromEnv,
  resetTopicRoutingForTesting,
  resolveFollowTarget,
  setTopicMappingStoreForTesting,
} from "./topic-routing.js";

type Mapping = { messageThreadId: number; createdAt: number };

function createFakeStore(initial: { key: string; value: Mapping }[] = []) {
  const data = new Map<string, Mapping>();
  for (const e of initial) data.set(e.key, e.value);
  return {
    data,
    store: {
      async register(key: string, value: Mapping) {
        data.set(key, value);
      },
      async delete(key: string) {
        return data.delete(key);
      },
      async entries() {
        return Array.from(data.entries()).map(([key, value]) => ({ key, value }));
      },
    },
  };
}

function stubFetch(handler: (url: string, body: Record<string, unknown>) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const response = handler(url, body);
      return new Response(JSON.stringify(response), { status: 200 });
    }),
  );
}

beforeEach(() => {
  resetTopicRoutingForTesting();
  vi.unstubAllGlobals();
  delete process.env.CLAUDE_BRIDGE_TOPIC_MODE;
  delete process.env.CLAUDE_BRIDGE_FORUM_GROUP_ID;
});

afterEach(() => {
  resetTopicRoutingForTesting();
  vi.unstubAllGlobals();
  delete process.env.CLAUDE_BRIDGE_TOPIC_MODE;
  delete process.env.CLAUDE_BRIDGE_FORUM_GROUP_ID;
});

describe("readTopicModeFromEnv", () => {
  it("defaults to 'off' when unset", () => {
    expect(readTopicModeFromEnv({})).toBe("off");
  });
  it("accepts per-cwd and per-session", () => {
    expect(readTopicModeFromEnv({ CLAUDE_BRIDGE_TOPIC_MODE: "per-cwd" })).toBe("per-cwd");
    expect(readTopicModeFromEnv({ CLAUDE_BRIDGE_TOPIC_MODE: "per-session" })).toBe("per-session");
  });
  it("falls back to 'off' for unknown values", () => {
    expect(readTopicModeFromEnv({ CLAUDE_BRIDGE_TOPIC_MODE: "bogus" })).toBe("off");
  });
});

describe("readForumGroupIdFromEnv", () => {
  it("returns undefined when empty / whitespace", () => {
    expect(readForumGroupIdFromEnv({})).toBeUndefined();
    expect(readForumGroupIdFromEnv({ CLAUDE_BRIDGE_FORUM_GROUP_ID: "   " })).toBeUndefined();
  });
  it("trims and returns the value", () => {
    expect(readForumGroupIdFromEnv({ CLAUDE_BRIDGE_FORUM_GROUP_ID: "  -100123 " })).toBe("-100123");
  });
});

describe("buildMappingKey", () => {
  it("distinguishes per-cwd from per-session", () => {
    const k1 = buildMappingKey({
      mode: "per-cwd",
      forumGroupId: "-100",
      cwd: "/a",
      sessionId: "s1",
    });
    const k2 = buildMappingKey({
      mode: "per-session",
      forumGroupId: "-100",
      cwd: "/a",
      sessionId: "s1",
    });
    expect(k1).not.toBe(k2);
  });
  it("namespaces by forum group id so dev/prod groups don't collide", () => {
    const dev = buildMappingKey({
      mode: "per-cwd",
      forumGroupId: "-100A",
      cwd: "/a",
      sessionId: "s1",
    });
    const prod = buildMappingKey({
      mode: "per-cwd",
      forumGroupId: "-100B",
      cwd: "/a",
      sessionId: "s1",
    });
    expect(dev).not.toBe(prod);
  });
});

describe("buildTopicName", () => {
  it("uses cwd basename for per-cwd", () => {
    expect(
      buildTopicName({ mode: "per-cwd", cwd: "/Users/x/code/chromite", sessionId: "abc123def" }),
    ).toBe("chromite");
  });
  it("uses bare short session id for per-session (no cwd prefix)", () => {
    expect(
      buildTopicName({
        mode: "per-session",
        cwd: "/Users/x/code/chromite",
        sessionId: "abc12345-678f-..",
      }),
    ).toBe("abc12345");
  });
});

describe("resolveFollowTarget", () => {
  it("returns DM target when mode=off", async () => {
    const target = await resolveFollowTarget({
      dmChatId: "12345",
      cwd: "/x/proj",
      sessionId: "s1",
      botToken: "T",
    });
    expect(target).toEqual({ chatId: "12345" });
  });

  it("returns DM target when mode is set but forum group id is missing", async () => {
    process.env.CLAUDE_BRIDGE_TOPIC_MODE = "per-cwd";
    const target = await resolveFollowTarget({
      dmChatId: "12345",
      cwd: "/x/proj",
      sessionId: "s1",
      botToken: "T",
    });
    expect(target).toEqual({ chatId: "12345" });
  });

  it("uses hydrated mapping when present (no createForumTopic call)", async () => {
    process.env.CLAUDE_BRIDGE_TOPIC_MODE = "per-cwd";
    process.env.CLAUDE_BRIDGE_FORUM_GROUP_ID = "-1001";
    const key = buildMappingKey({
      mode: "per-cwd",
      forumGroupId: "-1001",
      cwd: "/x/proj",
      sessionId: "s1",
    });
    const { store } = createFakeStore([{ key, value: { messageThreadId: 77, createdAt: 0 } }]);
    setTopicMappingStoreForTesting(store);
    await hydrateTopicMappingsFromStore();

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const target = await resolveFollowTarget({
      dmChatId: "12345",
      cwd: "/x/proj",
      sessionId: "s1",
      botToken: "T",
    });
    expect(target).toEqual({ chatId: "-1001", messageThreadId: 77 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("creates a new topic on cache miss and persists the mapping", async () => {
    process.env.CLAUDE_BRIDGE_TOPIC_MODE = "per-cwd";
    process.env.CLAUDE_BRIDGE_FORUM_GROUP_ID = "-1001";
    const { store, data } = createFakeStore();
    setTopicMappingStoreForTesting(store);
    await hydrateTopicMappingsFromStore();

    stubFetch(() => ({ ok: true, result: { message_thread_id: 88, name: "proj" } }));

    const target = await resolveFollowTarget({
      dmChatId: "12345",
      cwd: "/x/proj",
      sessionId: "s1",
      botToken: "T",
    });
    expect(target).toEqual({ chatId: "-1001", messageThreadId: 88 });
    // Allow microtask for the fire-and-forget store.register to flush.
    await new Promise((r) => setTimeout(r, 0));
    const persistedKey = buildMappingKey({
      mode: "per-cwd",
      forumGroupId: "-1001",
      cwd: "/x/proj",
      sessionId: "s1",
    });
    expect(data.get(persistedKey)?.messageThreadId).toBe(88);
  });

  it("falls back to DM when createForumTopic fails", async () => {
    process.env.CLAUDE_BRIDGE_TOPIC_MODE = "per-cwd";
    process.env.CLAUDE_BRIDGE_FORUM_GROUP_ID = "-1001";
    setTopicMappingStoreForTesting(null);

    stubFetch(() => ({
      ok: false,
      description: "Bad Request: chat is not a forum",
      error_code: 400,
    }));

    const target = await resolveFollowTarget({
      dmChatId: "12345",
      cwd: "/x/proj",
      sessionId: "s1",
      botToken: "T",
    });
    expect(target).toEqual({ chatId: "12345" });
  });
});

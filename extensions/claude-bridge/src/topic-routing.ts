// Decides where a follow stream's output messages land:
//   - "off" (default): same DM chat the /claude command came from
//   - "per-cwd": one forum topic per project directory (sessions from the
//     same repo merge into one thread, history reads as one project log)
//   - "per-session": one forum topic per claude session id (max isolation;
//     each new session shows up as a fresh thread)
//
// Topics live in a separate forum-enabled supergroup (DMs can't host
// topics). Interactive panels / approval cards stay in DM; only the
// long-form claude tail streams route into the forum. This decouples
// "noisy long output" from "tight interaction", which is the core UX
// motivation for the whole feature.
//
// Configuration via env (read at routing time so changes don't need a
// daemon restart):
//   CLAUDE_BRIDGE_FORUM_GROUP_ID  — forum supergroup chat id (e.g. "-1001234")
//   CLAUDE_BRIDGE_TOPIC_MODE      — "off" | "per-cwd" | "per-session"
//
// Mapping store: SQLite-backed plugin keyed-store, same pattern as
// chat-state-store.ts — hydrate-once-into-memory on plugin init so the
// hot lookup path is synchronous; mutations write through asynchronously.
// Disabling on error degrades to "create a fresh topic every time" (still
// functional, just messier UI).

import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { createForumTopic } from "./telegram-bot-api.js";

export type TopicMode = "off" | "per-cwd" | "per-session";

export type FollowTarget = {
  chatId: string;
  /** Forum topic thread id. Undefined when routing to DM. */
  messageThreadId?: number;
};

export type ResolveFollowTargetInput = {
  /** Source DM chat id (the chat that issued /claude). */
  dmChatId: string;
  cwd: string;
  sessionId: string;
  botToken: string;
};

const STORE_NAMESPACE = "claude-bridge.topic-routing";
const STORE_MAX_ENTRIES = 1_000;

type TopicMappingRecord = {
  messageThreadId: number;
  createdAt: number;
};

// Narrow local view of the SDK keyed-store contract. Mirrors what
// chat-state-store.ts does — `register` writes through, `entries` is
// only consulted at hydrate-time. No per-call `get`: the synchronous
// hot path reads from the in-memory MAPPINGS Map below.
type TopicMappingStore = {
  register(key: string, value: TopicMappingRecord, opts?: { ttlMs?: number }): Promise<void>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<{ key: string; value: TopicMappingRecord }[]>;
};

const MAPPINGS = new Map<string, TopicMappingRecord>();

let runtimeRef: PluginRuntime | undefined;
let cachedStore: TopicMappingStore | undefined;
let storeDisabled = false;
let testStoreOverride: TopicMappingStore | null | undefined;

export function setTopicRoutingRuntime(runtime: PluginRuntime | undefined): void {
  runtimeRef = runtime;
  cachedStore = undefined;
  storeDisabled = false;
}

export function setTopicMappingStoreForTesting(store: TopicMappingStore | null | undefined): void {
  testStoreOverride = store;
  cachedStore = undefined;
  storeDisabled = false;
}

export function resetTopicRoutingForTesting(): void {
  runtimeRef = undefined;
  cachedStore = undefined;
  storeDisabled = false;
  testStoreOverride = undefined;
  MAPPINGS.clear();
}

function getStore(): TopicMappingStore | undefined {
  if (testStoreOverride !== undefined) {
    return testStoreOverride ?? undefined;
  }
  if (storeDisabled) return undefined;
  if (cachedStore) return cachedStore;
  if (!runtimeRef) return undefined;
  try {
    cachedStore = runtimeRef.state.openKeyedStore<TopicMappingRecord>({
      namespace: STORE_NAMESPACE,
      maxEntries: STORE_MAX_ENTRIES,
    });
    return cachedStore;
  } catch (error) {
    disable(error, "open");
    return undefined;
  }
}

/**
 * Read everything from the persistent store into the in-memory MAPPINGS
 * Map. Call once at plugin init. Best-effort: failure leaves the Map
 * empty and the store disabled, so all subsequent lookups treat the
 * cache as a miss and (in forum mode) try to create a fresh topic.
 */
export async function hydrateTopicMappingsFromStore(): Promise<void> {
  const store = getStore();
  if (!store) return;
  try {
    const rows = await store.entries();
    MAPPINGS.clear();
    for (const row of rows) {
      MAPPINGS.set(row.key, row.value);
    }
  } catch (error) {
    disable(error, "entries");
  }
}

function disable(error: unknown, op: string): void {
  storeDisabled = true;
  cachedStore = undefined;
  try {
    runtimeRef?.logging
      .getChildLogger({ plugin: "claude-bridge", feature: "topic-routing" })
      .warn("claude-bridge topic routing store disabled", { op, error: String(error) });
  } catch {
    // observability is best-effort
  }
}

export function readTopicModeFromEnv(env: NodeJS.ProcessEnv = process.env): TopicMode {
  const raw = env.CLAUDE_BRIDGE_TOPIC_MODE?.trim().toLowerCase();
  if (raw === "per-cwd" || raw === "per-session") return raw;
  return "off";
}

export function readForumGroupIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.CLAUDE_BRIDGE_FORUM_GROUP_ID?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

/**
 * Topic-mapping cache key. Includes the forum group id so the same cwd /
 * sessionId can map to different topics across multiple deployments
 * (dev vs prod groups) without collision.
 */
export function buildMappingKey(input: {
  mode: TopicMode;
  forumGroupId: string;
  cwd: string;
  sessionId: string;
}): string {
  switch (input.mode) {
    case "per-cwd":
      return `${input.forumGroupId}|cwd:${input.cwd}`;
    case "per-session":
      return `${input.forumGroupId}|session:${input.sessionId}`;
    case "off":
      return `${input.forumGroupId}|off`;
  }
}

/**
 * Topic display name.
 *  - per-session: the short session id alone — single-project deployments
 *    don't need a cwd prefix to disambiguate, and bare sids scan cleanly
 *    in Telegram's topic list.
 *  - per-cwd: the directory basename — stable, scan-friendly label that
 *    groups all sessions for one project under one thread.
 */
export function buildTopicName(input: { mode: TopicMode; cwd: string; sessionId: string }): string {
  if (input.mode === "per-session") {
    return input.sessionId.slice(0, 8);
  }
  return path.basename(input.cwd) || "claude";
}

export async function resolveFollowTarget(input: ResolveFollowTargetInput): Promise<FollowTarget> {
  const mode = readTopicModeFromEnv();
  const forumGroupId = readForumGroupIdFromEnv();

  // Off, missing group, or in-DM fallback all land at the DM chat.
  if (mode === "off" || !forumGroupId) {
    return { chatId: input.dmChatId };
  }

  const key = buildMappingKey({
    mode,
    forumGroupId,
    cwd: input.cwd,
    sessionId: input.sessionId,
  });

  // Synchronous lookup against the hydrated in-memory cache.
  const existing = MAPPINGS.get(key);
  if (existing) {
    return { chatId: forumGroupId, messageThreadId: existing.messageThreadId };
  }

  // No cached mapping — try to create a fresh topic. On failure, fall back
  // to DM rather than dropping the message.
  const topicName = buildTopicName({ mode, cwd: input.cwd, sessionId: input.sessionId });
  const created = await createForumTopic({
    botToken: input.botToken,
    chatId: forumGroupId,
    name: topicName,
  });
  if (!created.ok) {
    runtimeRef?.logging
      .getChildLogger({ plugin: "claude-bridge", feature: "topic-routing" })
      .warn("createForumTopic failed; falling back to DM", {
        forumGroupId,
        topicName,
        description: created.description,
        status: created.status,
      });
    return { chatId: input.dmChatId };
  }

  const record: TopicMappingRecord = {
    messageThreadId: created.messageThreadId,
    createdAt: Date.now(),
  };
  MAPPINGS.set(key, record);

  const store = getStore();
  if (store) {
    void store.register(key, record).catch((error) => disable(error, "register"));
  }

  return { chatId: forumGroupId, messageThreadId: created.messageThreadId };
}

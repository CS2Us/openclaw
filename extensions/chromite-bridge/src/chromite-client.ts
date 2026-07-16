// chromite edge-loop client —— thin TS adapter over the napi-rs native addon.
//
// 架构演进（sub-spec 6 napi-openclaw, RC3 single-source-of-truth）：本 bridge 曾持
// 一个**重复实现**的 TS edge loop（runGatewayTurn / execCommerceTool / parseSse /
// runEdgeLoop）。它已**全删**——openclaw 现在消费与 App 完全相同的 Rust core
// (`chromite-client` crate) 经 napi 暴露的同一个 edge loop。本文件退化为薄适配层：
// marshal `EdgeLoopOptions` -> `EdgeLoopConfigJs`，调 addon，map 回 bridge 的结果型。
//
// 这消除了双端漂移：原先 fixtures/*.json 由 Rust parity.rs + 本 bridge 的 TS loop
// 两端各跑一遍互证；现在单端（Rust），parity.test.ts 改为驱动 napi addon 跑同一组
// fixture，作为 napi 路径上的 TS-side 回归测试。
//
// 边界注意（与已删 TS loop 的行为差异，wiring 时已知并接受）：
//   - serverTools 清单（C1, 见 chromite-client-napi/src/lib.rs §dispatcher）：napi
//     binding 不做 catch-all 路由（sub-spec 3 bounded routing 刻意杀掉了 catch-all）。
//     已删 TS loop 盲发任意 tool name 到 /v1/commerce/<name>；为在不破 bounded routing
//     的前提下保留这个 reach，caller 必须把 commerce 工具名清单作为 serverTools 传入。
//     本文件持一份 checked-in 清单 COMMERCE_TOOL_MANIFEST（与 chromite 的 disc/tools
//     `fn name` 返回值对齐）。未列入清单的 name fail-soft 成 "unknown tool"，不发 HTTP。
//   - AbortSignal：napi 的 async fn 不接受 AbortSignal，JS 侧无法 mid-flight 取消
//     native loop。handler.ts 的 timeout 仍靠 `signal` 驱动——本适配层用 Promise.race
//     让超时**reject** JS promise（native loop 仍跑完，但 caller 拿到超时回复）。这是
//     coarse cancel（abandon, not cancel），是当前 napi 接口的已知取舍。
//   - fetchImpl test seam：已删（ReqwestTransport 在 Rust 内 hardcoded）。parity.test.ts
//     改为对一个本地 node:http fake server 跑真实 loopback HTTP。

import {
  resolveIdentity as addonResolveIdentity,
  runEdgeLoopNapi,
  type EdgeLoopConfigJs,
} from "@openclaw/chromite-native";

const TELEGRAM_CHANNEL = "telegram";

/**
 * Authoritative commerce tool-name manifest (C1 bounded routing).
 *
 * Mirrors the `fn name(&self) -> &str` returns of chromite's
 * `agents-commerce/src/disc/tools/*` implementations. A tool name the LLM emits
 * that is NOT in this set fail-softs inside the Rust loop to an "unknown tool"
 * tool-result string and never hits `/v1/commerce/<name>`. Keep in sync when a
 * commerce tool is added/removed on the server.
 */
export const COMMERCE_TOOL_MANIFEST: readonly string[] = [
  "commerce_attach_product",
  "commerce_attach_store",
  "commerce_create_order",
  "commerce_create_order_with_bargain",
  "commerce_detach",
  "commerce_list_attached",
  "commerce_list_catalog",
  "commerce_pay",
  "commerce_search_catalog",
];

export type EdgeLoopOptions = {
  chromiteUrl: string;
  /** 身份 channel（v1 恒为 "telegram"）。 */
  channel: string;
  /** channel-scoped user id；v1 session token = channel_user_id。 */
  channelUserId: string;
  /**
   * Abort signal —— now only drives a coarse JS-side timeout (Promise.race). It
   * CANNOT cancel the in-flight native loop; the loop runs to completion in the
   * background while the caller's promise rejects on abort. See module header.
   */
  signal?: AbortSignal;
  /** loop 上限（默认由 Rust core clamp 到 8）。 */
  maxTurns?: number;
  /**
   * commerce 工具名清单覆盖（默认 COMMERCE_TOOL_MANIFEST）。仅 parity 测试需要——
   * 它从 fixture 的 commerce 路径派生清单以忠实复现路由（含 fixture-only 的 fake
   * 工具名如 commerce_loop）。生产路径不传，用 checked-in 清单。
   */
  serverTools?: readonly string[];
  /**
   * OPT-IN durable resilience (chromite sub-spec ④ R1). When set, the native loop
   * persists per-`convId` pending snapshots under this dir and restores an
   * interrupted loop on a later call with the same `convId`. Absent → the existing
   * non-resumable path. Production callers derive it from `resolvePendingStoreDir`
   * (operator env-gated). See the ⚠️ idempotency gate on `EdgeLoopConfigJs`.
   */
  pendingStoreDir?: string;
};

export type IdentityResolveResult = {
  userId: string;
  provisional: boolean;
};

/** 客户端可渲染交互件（interaction-projection-v1）。 */
export type EdgeLoopClientAction = {
  kind: string;
  version: number;
  projection: unknown;
};

export type EdgeLoopResult = {
  reply: string;
  /** 跑了几轮 gateway turn。 */
  iterations: number;
  /** 是否因撞 maxTurns 上限退出（而非自然 end-of-turn）。 */
  hitMaxTurns: boolean;
  /**
   * interaction-projection-v1：core 收集的客户端可渲染交互件（如 `interaction_projection`）。
   * secret 已在 core 从回喂 LLM 剥离；这些只随终态出。默认空。
   */
  clientActions: EdgeLoopClientAction[];
};

/**
 * defensive 读 napi `EdgeLoopResultJs.clientActions`。napi crate 已加该字段，但 openclaw 侧
 * binding（`@openclaw/chromite-native` 的 `.node` + `.d.ts`）**需重 build** 才可见——重生成前
 * 该字段编译期不存在，故用 `unknown` narrowing 读，退化空数组；binding 重 build 后即真透传。
 */
function readClientActions(r: unknown): EdgeLoopClientAction[] {
  if (typeof r !== "object" || r === null) {
    return [];
  }
  const raw = (r as Record<string, unknown>).clientActions;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: EdgeLoopClientAction[] = [];
  for (const a of raw) {
    if (typeof a === "object" && a !== null) {
      const rec = a as Record<string, unknown>;
      const projection = decodeProjection(rec.projection);
      if (typeof rec.kind === "string" && typeof rec.version === "number" && projection !== null) {
        out.push({ kind: rec.kind, version: rec.version, projection });
      }
    }
  }
  return out;
}

function decodeProjection(raw: unknown): unknown | null {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object" && raw !== null) {
    return raw;
  }
  return null;
}

/** Marshal the bridge's `EdgeLoopOptions` onto the napi `EdgeLoopConfigJs`. */
function toConfig(opts: EdgeLoopOptions): EdgeLoopConfigJs {
  return {
    baseUrl: opts.chromiteUrl,
    channel: opts.channel || TELEGRAM_CHANNEL,
    channelUserId: opts.channelUserId,
    // 0/undefined -> Rust core clamps to the default 8 (single source of clamp).
    maxTurns: opts.maxTurns,
    serverTools: [...(opts.serverTools ?? COMMERCE_TOOL_MANIFEST)],
    // undefined -> non-resumable path (in-memory store); set -> FilePendingStore +
    // run_edge_loop_resumable. See the ⚠️ idempotency gate on EdgeLoopConfigJs.
    pendingStoreDir: opts.pendingStoreDir,
  };
}

/**
 * Race a native-addon promise against the abort signal. The napi fns take no
 * AbortSignal, so this is a COARSE timeout: on abort the returned promise rejects
 * (handler.ts then renders the timeout reply) while the native loop keeps running
 * to completion in the background. Without a signal, returns the promise as-is.
 */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

// ===== identity resolve =====

/**
 * POST /v1/identity/resolve via the napi addon —— 绑 (channel, channel_user_id)
 * 使后续 /v1/commerce/* 零信任 RPC 能解析到 user（首次接触自动建 provisional 影子号）。
 * 非 2xx / 非法响应在 Rust 内变成 rejected promise（verbatim TS-parity message）。
 */
export async function resolveIdentity(opts: EdgeLoopOptions): Promise<IdentityResolveResult> {
  const r = await withAbort(addonResolveIdentity(toConfig(opts)), opts.signal);
  return { userId: r.userId, provisional: r.provisional };
}

// ===== relay ticket (chromite-relay-session-auth-v1) =====

/**
 * POST /v1/relay/tickets —— 换取买家订阅 relay push 的 60s HS256 join ticket。
 *
 * server 侧过零信任 layer（X-Session-Token = 买家 channel_user_id）+ 买家归属授权
 * （ConvAuthorizer）后签票。**永不抛**：任何失败（网络 / 401 / 403 / 503 / 缺
 * senderId）返回 null，调用方（relay-push join）留给 ensure-joined 重试环，
 * fail-visible 不静默。
 */
export async function fetchRelayTicket(params: {
  chromiteUrl: string;
  orderId: string;
  senderId: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<string | null> {
  const { chromiteUrl, orderId, senderId } = params;
  if (!senderId) {
    return null;
  }
  const fetchFn = params.fetchImpl ?? fetch;
  const url = `${chromiteUrl.replace(/\/+$/, "")}/v1/relay/tickets`;
  try {
    const resp = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Token": senderId,
        "X-Channel": TELEGRAM_CHANNEL,
      },
      body: JSON.stringify({ conv_id: orderId }),
      signal: params.signal,
    });
    if (!resp.ok) {
      return null;
    }
    const parsed = (await resp.json()) as { ticket?: unknown };
    return typeof parsed.ticket === "string" ? parsed.ticket : null;
  } catch {
    return null;
  }
}

// ===== edge agent loop =====

/**
 * 端侧 agent loop（现在是 Rust）：调 gateway turn，遇 tool_call 执行 commerce RPC
 * 回喂后继续，直到 LLM 不再调工具（最终回复）或撞 maxTurns 上限。整个状态机在
 * `chromite-client` crate 内，经 napi 暴露——本函数只 marshal 进出。
 */
export async function runEdgeLoop(
  userMsg: string,
  convId: string,
  opts: EdgeLoopOptions,
): Promise<EdgeLoopResult> {
  const r = await withAbort(runEdgeLoopNapi(userMsg, convId, toConfig(opts)), opts.signal);
  return {
    reply: r.reply,
    iterations: r.iterations,
    hitMaxTurns: r.hitMaxTurns,
    clientActions: readClientActions(r),
  };
}

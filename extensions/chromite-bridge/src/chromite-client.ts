// chromite edge-loop client —— hybrid-harness Part B (client-side agent loop).
//
// 架构演进（2026-05-30, hybrid-harness）：chromite-server 的 server-side agent
// loop (`/v1/chat/stream`) 已**全删**。Agent Loop 状态机下放给**边缘客户端**（本
// bridge）。本模块持 loop：
//
//   1. resolveIdentity → POST /v1/identity/resolve（绑 channel↔user，使后续零信任
//      commerce RPC 可解析身份；首次接触自动建 provisional 影子号）。
//   2. runEdgeLoop → 反复调 /v1/gateway/chat/completions（无状态 OpenAI-compatible
//      SSE；客户端每轮发完整 messages），解析 gateway SSE 事件累积 text + tool_use；
//      有 tool_call 则经 /v1/commerce/<tool>（零信任 header）执行后回喂 ToolResult
//      并继续；无 tool_call 则该 text 是最终回复。
//
// gateway SSE 事件（与已删 server-loop 事件不同）：
//   message_start {} · text_delta {delta} · tool_use_start {index,id,name}
//   tool_use_input_delta {index,partial_json} · content_block_stop {index}
//   message_delta {stop_reason}  ← 一轮结束
//
// 源契约见 chromite crates/server/src/{gateway_chat,identity_rest,commerce_rest,
// commerce_rpc_zero_trust}.rs。

const TELEGRAM_CHANNEL = "telegram";
const DEFAULT_MAX_TURNS = 8;

/** v1 session token Header（值 = channel_user_id，见 commerce_rpc_zero_trust.rs）。 */
const HEADER_SESSION_TOKEN = "X-Session-Token";
/** channel 覆盖 Header（值 = telegram）。 */
const HEADER_CHANNEL = "X-Channel";

/** OpenAI-compatible message（无状态 gateway：客户端每轮拼完整历史；不发 system）。 */
export type GatewayMessage = {
  role: "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: GatewayToolCall[];
  tool_call_id?: string;
};

export type GatewayToolCall = {
  id: string;
  function: { name: string; arguments: string };
};

/** 解析完一轮 gateway SSE 后的产物。 */
export type GatewayTurn = {
  /** 累积的 assistant 文本（text_delta 拼接）。 */
  text: string;
  /** 本轮 LLM 发起的 tool 调用（按 tool_use_start 的 index 累积 input delta）。 */
  toolCalls: ParsedToolCall[];
  /** message_delta 携带的 stop_reason（可能为 null）。 */
  stopReason: string | null;
};

export type ParsedToolCall = {
  id: string;
  name: string;
  /** 累积的参数 JSON 字符串（tool_use_input_delta 拼接；可能为空 / 非法）。 */
  argsJson: string;
};

export type EdgeLoopOptions = {
  chromiteUrl: string;
  /** 身份 channel（v1 恒为 "telegram"）。 */
  channel: string;
  /** channel-scoped user id；v1 session token = channel_user_id。 */
  channelUserId: string;
  signal?: AbortSignal;
  /** Test seam —— 注入确定性 fetch。 */
  fetchImpl?: typeof fetch;
  /** loop 上限（默认 8）。 */
  maxTurns?: number;
};

export type IdentityResolveResult = {
  userId: string;
  provisional: boolean;
};

export type EdgeLoopResult = {
  reply: string;
  /** 跑了几轮 gateway turn。 */
  iterations: number;
  /** 是否因撞 maxTurns 上限退出（而非自然 end-of-turn）。 */
  hitMaxTurns: boolean;
};

// ===== identity resolve =====

/**
 * POST /v1/identity/resolve —— 确保 (channel, channel_user_id) 已绑（首次接触自动
 * 建 provisional 影子号），使后续 /v1/commerce/* 零信任 RPC 能解析到 user。
 * 每轮 loop 前调一次。非 2xx / 非法响应抛错（caller 转 graceful reply）。
 */
export async function resolveIdentity(opts: EdgeLoopOptions): Promise<IdentityResolveResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const url = `${opts.chromiteUrl}/v1/identity/resolve`;
  const resp = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channel: opts.channel || TELEGRAM_CHANNEL,
      channel_user_id: opts.channelUserId,
    }),
    signal: opts.signal,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`chromite identity/resolve ${resp.status}: ${body || "<empty>"}`);
  }
  const parsed = (await resp.json().catch(() => null)) as {
    user_id?: string;
    provisional?: boolean;
  } | null;
  if (!parsed || typeof parsed.user_id !== "string") {
    throw new Error("chromite identity/resolve returned no user_id");
  }
  return { userId: parsed.user_id, provisional: Boolean(parsed.provisional) };
}

// ===== edge agent loop =====

/**
 * 端侧 agent loop：调 gateway turn，遇 tool_call 执行 commerce RPC 回喂后继续，
 * 直到 LLM 不再调工具（最终回复）或撞 maxTurns 上限。
 */
export async function runEdgeLoop(
  userMsg: string,
  convId: string,
  opts: EdgeLoopOptions,
): Promise<EdgeLoopResult> {
  const maxTurns = opts.maxTurns && opts.maxTurns > 0 ? opts.maxTurns : DEFAULT_MAX_TURNS;
  const messages: GatewayMessage[] = [{ role: "user", content: userMsg }];
  let lastText = "";

  for (let iterations = 1; iterations <= maxTurns; iterations++) {
    const turn = await runGatewayTurn(messages, convId, opts);
    lastText = turn.text;

    if (turn.toolCalls.length === 0) {
      // 无 tool_call → 本轮 text 即最终回复。
      return { reply: turn.text, iterations, hitMaxTurns: false };
    }

    // 有 tool_call → 把 assistant 回合（text + tool_calls）入栈，执行每个 tool 回喂。
    messages.push({
      role: "assistant",
      content: turn.text || null,
      tool_calls: turn.toolCalls.map((tc) => ({
        id: tc.id,
        function: { name: tc.name, arguments: tc.argsJson || "{}" },
      })),
    });
    for (const tc of turn.toolCalls) {
      const result = await execCommerceTool(tc, opts);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }

  // maxTurns 耗尽 —— 返回最后看到的 text（可能为空）。
  return {
    reply: lastText || "(已达最大轮次)",
    iterations: maxTurns,
    hitMaxTurns: true,
  };
}

/**
 * 调 POST /v1/gateway/chat/completions（无状态 SSE），解析 gateway 事件累积 text +
 * tool_use（按 index），捕获 stop_reason。非 2xx / 无 body 时抛错。
 */
export async function runGatewayTurn(
  messages: GatewayMessage[],
  convId: string,
  opts: EdgeLoopOptions,
): Promise<GatewayTurn> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const url = `${opts.chromiteUrl}/v1/gateway/chat/completions`;
  const resp = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ messages, conv_id: convId }),
    signal: opts.signal,
  });

  if (!resp.ok || !resp.body) {
    const body = await resp.text().catch(() => "");
    throw new Error(`chromite gateway endpoint ${resp.status}: ${body || "<empty>"}`);
  }

  let text = "";
  let stopReason: string | null = null;
  // tool_use 累积器：index → 部分 tool call（input delta 拼接）。
  const toolsByIndex = new Map<number, ParsedToolCall>();
  // 保序：tool_use_start 出现顺序 = 最终 toolCalls 顺序。
  const order: number[] = [];

  for await (const ev of parseSseStream(resp.body)) {
    switch (ev.name) {
      case "text_delta": {
        const delta = ev.data.delta;
        if (typeof delta === "string") {
          text += delta;
        }
        break;
      }
      case "tool_use_start": {
        const index = toNumber(ev.data.index);
        if (index === null) {
          break;
        }
        if (!toolsByIndex.has(index)) {
          order.push(index);
        }
        toolsByIndex.set(index, {
          id: asString(ev.data.id),
          name: asString(ev.data.name),
          argsJson: "",
        });
        break;
      }
      case "tool_use_input_delta": {
        const index = toNumber(ev.data.index);
        if (index === null) {
          break;
        }
        const cur = toolsByIndex.get(index);
        if (cur && typeof ev.data.partial_json === "string") {
          cur.argsJson += ev.data.partial_json;
        }
        break;
      }
      case "message_delta": {
        const sr = ev.data.stop_reason;
        stopReason = typeof sr === "string" ? sr : null;
        break;
      }
      // message_start / content_block_stop —— 无累积副作用，忽略。
      default:
        break;
    }
  }

  const toolCalls = order
    .map((idx) => toolsByIndex.get(idx))
    .filter((tc): tc is ParsedToolCall => tc !== undefined);

  return { text, toolCalls, stopReason };
}

/**
 * POST /v1/commerce/<tool>（零信任）：headers 带 X-Session-Token (= channel_user_id)
 * + X-Channel: telegram。body = 解析后的 tool input（空 / 非法 → `{}`）。
 *
 * fail-soft：非 2xx（如 401）**不**抛错——回喂结构化 error 字符串让 LLM 据此反应，
 * loop 继续。返回值始终是要塞进 ToolResult 的字符串。
 */
export async function execCommerceTool(
  toolCall: ParsedToolCall,
  opts: EdgeLoopOptions,
): Promise<string> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const url = `${opts.chromiteUrl}/v1/commerce/${toolCall.name}`;
  const input = parseToolInput(toolCall.argsJson);

  try {
    const resp = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [HEADER_SESSION_TOKEN]: opts.channelUserId,
        [HEADER_CHANNEL]: opts.channel || TELEGRAM_CHANNEL,
      },
      body: JSON.stringify(input),
      signal: opts.signal,
    });
    const body = await resp.text();
    if (!resp.ok) {
      // 不抛——回喂 error 让 LLM 反应（401 等）。
      return JSON.stringify({
        error: `commerce ${toolCall.name} ${resp.status}`,
        detail: body.slice(0, 500),
      });
    }
    return body;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return JSON.stringify({
      error: `commerce ${toolCall.name} request_failed`,
      detail,
    });
  }
}

// ===== SSE 解析 =====

type SseEvent = {
  name: string;
  data: Record<string, unknown>;
};

/**
 * SSE async generator —— 按 `event:` / `data:` 行解析，event 间以空行 (\n\n) 分隔，
 * data JSON-parse。straddle 网络 read 边界的事件被正确缓冲。沿用旧 client 的
 * 分块风格，但事件是 NEW（gateway 事件，非 server-loop 事件）。
 */
async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        const trailing = parseSseChunk(buf);
        if (trailing) {
          yield trailing;
        }
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseSseChunk(chunk);
        if (ev) {
          yield ev;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released / stream errored — ignore
    }
  }
}

/**
 * 解析单个 SSE chunk：
 *   event: <name>\n
 *   data: <json>\n
 * `:` 开头是 keep-alive 注释（"ka"），跳过。data 非 JSON / 缺 event 名 → null。
 */
function parseSseChunk(chunk: string): SseEvent | null {
  if (!chunk.trim()) {
    return null;
  }
  let name = "";
  const dataLines: string[] = [];
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event:")) {
      name = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
    // `:` keep-alive / 其它行 —— skip
  }
  if (!name) {
    return null;
  }
  const data = dataLines.join("\n");
  try {
    const parsed = data ? JSON.parse(data) : {};
    if (parsed && typeof parsed === "object") {
      return { name, data: parsed as Record<string, unknown> };
    }
    return { name, data: {} };
  } catch {
    // 非 JSON data（如 keep-alive 有时落成纯文本）—— skip
    return null;
  }
}

// ===== helpers =====

/** 解析 tool call 累积的 argsJson；空 / 非法 → `{}`。 */
function parseToolInput(argsJson: string): unknown {
  const trimmed = argsJson.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return null;
}

/** Safe string coercion for SSE-derived `unknown` fields (id/name). */
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

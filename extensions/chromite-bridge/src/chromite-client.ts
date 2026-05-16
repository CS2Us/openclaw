// chromite-server HTTP/SSE client —— v1 collect-then-reply 形态。
// sub-spec chromite-harness-openclaw-bridge-v1 §1 + §3 决策 #B 修正.
//
// `streamChromiteChat` 调 POST /v1/chat/stream，按 SSE 协议解析 event-name + data
// JSON，async generator 形式 yield 每个 ChromiteEvent。
//
// `collectChromiteReply` wraps `streamChromiteChat`：累积 text_delta + tool_call
// 折叠提示，TurnCompleted / Error / 超时时返回最终回复文本。

export type ChromiteEvent =
  | { type: "turn_started"; turn_id: string }
  | { type: "text_delta"; turn_id: string; delta: string }
  | { type: "tool_call"; turn_id: string; tool: string; input: unknown }
  | { type: "tool_result"; turn_id: string; tool: string; output: unknown }
  | { type: "metadata"; turn_id: string; source: string; data: unknown }
  | {
      type: "turn_completed";
      turn_id: string;
      iterations: number;
      hit_max_turns: boolean;
    }
  | { type: "aborted"; turn_id: string }
  | { type: "error"; message: string };

export type ChromiteChatRequest = {
  session_id: string;
  user_msg: string;
  /**
   * Identity resolution channel hint (spec resolution-middleware-v1 §2 #A).
   * v1: only `"telegram"`. Optional; when omitted chromite skips identity
   * resolution and proceeds (dev / CLI parity).
   */
  channel?: string;
  /**
   * Channel-scoped user id (telegram user_id etc.); paired with `channel`.
   */
  channel_user_id?: string;
};

export type StreamOptions = {
  chromiteUrl: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

/**
 * SSE async generator —— 调 chromite POST /v1/chat/stream，yield 每个 ChromiteEvent。
 * 上游断开 / abort / 非 2xx 时抛错（caller 转 ChromiteEvent.Error）。
 */
export async function* streamChromiteChat(
  req: ChromiteChatRequest,
  opts: StreamOptions,
): AsyncGenerator<ChromiteEvent, void, void> {
  const url = `${opts.chromiteUrl}/v1/chat/stream`;
  const fetchFn = opts.fetchImpl ?? fetch;
  const resp = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(req),
    signal: opts.signal,
  });

  if (!resp.ok || !resp.body) {
    const body = await resp.text().catch(() => "");
    throw new Error(`chromite chat endpoint ${resp.status}: ${body || "<empty>"}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        // flush any remaining event in buf
        const trailing = parseEvent(buf);
        if (trailing) {
          yield trailing;
        }
        return;
      }
      buf += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines (\n\n).
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseEvent(chunk);
        if (ev) {
          yield ev;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore — already released or stream errored
    }
  }
}

/**
 * 解析单个 SSE event chunk ——
 *   event: <name>\n
 *   data: <json>\n
 *
 * `event:` 行缺省时默认为 "message"；本协议 chromite 总是提供 event 名。
 */
function parseEvent(chunk: string): ChromiteEvent | null {
  if (!chunk.trim()) return null;
  let name = "";
  const dataLines: string[] = [];
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event:")) {
      name = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    } else if (line.startsWith(":")) {
      // SSE comment / keep-alive ("ka") —— skip
    }
  }
  if (!name) return null;
  const data = dataLines.join("\n");
  try {
    const parsed = data ? JSON.parse(data) : {};
    return materializeEvent(name, parsed);
  } catch {
    // Non-JSON data (e.g. keep-alive "ka" sometimes lands as plain text) — skip
    return null;
  }
}

function materializeEvent(name: string, data: unknown): ChromiteEvent | null {
  const obj = (data ?? {}) as Record<string, unknown>;
  switch (name) {
    case "turn_started":
      return { type: "turn_started", turn_id: String(obj.turn_id ?? "") };
    case "text_delta":
      return {
        type: "text_delta",
        turn_id: String(obj.turn_id ?? ""),
        delta: String(obj.delta ?? ""),
      };
    case "tool_call":
      return {
        type: "tool_call",
        turn_id: String(obj.turn_id ?? ""),
        tool: String(obj.tool ?? ""),
        input: obj.input ?? null,
      };
    case "tool_result":
      return {
        type: "tool_result",
        turn_id: String(obj.turn_id ?? ""),
        tool: String(obj.tool ?? ""),
        output: obj.output ?? null,
      };
    case "metadata":
      return {
        type: "metadata",
        turn_id: String(obj.turn_id ?? ""),
        source: String(obj.source ?? ""),
        data: obj.data ?? null,
      };
    case "turn_completed":
      return {
        type: "turn_completed",
        turn_id: String(obj.turn_id ?? ""),
        iterations: Number(obj.iterations ?? 0),
        hit_max_turns: Boolean(obj.hit_max_turns),
      };
    case "aborted":
      return { type: "aborted", turn_id: String(obj.turn_id ?? "") };
    case "error":
      return { type: "error", message: String(obj.message ?? "unknown error") };
    default:
      return null;
  }
}

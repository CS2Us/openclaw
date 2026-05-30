import { describe, expect, it, vi } from "vitest";
import {
  execCommerceTool,
  resolveIdentity,
  runEdgeLoop,
  runGatewayTurn,
  type EdgeLoopOptions,
  type GatewayMessage,
} from "./chromite-client.js";

/** Build a `Response` whose body streams the given SSE chunks. */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Build a JSON `Response`. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Build a plain-text `Response` (e.g. commerce tool output is a raw string body). */
function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function baseOpts(overrides: Partial<EdgeLoopOptions> = {}): EdgeLoopOptions {
  return {
    chromiteUrl: "http://x:8080",
    channel: "telegram",
    channelUserId: "8797479017",
    ...overrides,
  };
}

/** SSE for a turn that emits text then ends (no tool calls). */
function textTurnChunks(text: string): string[] {
  return [
    "event: message_start\ndata: {}\n\n",
    `event: text_delta\ndata: ${JSON.stringify({ delta: text })}\n\n`,
    'event: message_delta\ndata: {"stop_reason":"end_turn"}\n\n',
  ];
}

/** SSE for a turn that emits a single tool_use (id/name + streamed args JSON). */
function toolTurnChunks(opts: {
  id: string;
  name: string;
  argsParts: string[];
  text?: string;
}): string[] {
  const chunks: string[] = ["event: message_start\ndata: {}\n\n"];
  if (opts.text) {
    chunks.push(`event: text_delta\ndata: ${JSON.stringify({ delta: opts.text })}\n\n`);
  }
  chunks.push(
    `event: tool_use_start\ndata: ${JSON.stringify({ index: 0, id: opts.id, name: opts.name })}\n\n`,
  );
  for (const part of opts.argsParts) {
    chunks.push(
      `event: tool_use_input_delta\ndata: ${JSON.stringify({ index: 0, partial_json: part })}\n\n`,
    );
  }
  chunks.push('event: content_block_stop\ndata: {"index":0}\n\n');
  chunks.push('event: message_delta\ndata: {"stop_reason":"tool_use"}\n\n');
  return chunks;
}

describe("resolveIdentity", () => {
  it("POSTs to /v1/identity/resolve with telegram channel + channel_user_id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ user_id: "uuid-1", provisional: true }));
    const result = await resolveIdentity(
      baseOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://x:8080/v1/identity/resolve");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.channel).toBe("telegram");
    expect(body.channel_user_id).toBe("8797479017");

    expect(result).toEqual({ userId: "uuid-1", provisional: true });
  });

  it("throws on non-2xx so caller can render a graceful reply", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "InvalidArgument", message: "bad" }, 400),
    );
    await expect(
      resolveIdentity(baseOpts({ fetchImpl: fetchImpl as unknown as typeof fetch })),
    ).rejects.toThrow(/identity\/resolve 400/);
  });

  it("throws when response lacks user_id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ provisional: false }));
    await expect(
      resolveIdentity(baseOpts({ fetchImpl: fetchImpl as unknown as typeof fetch })),
    ).rejects.toThrow(/no user_id/);
  });
});

describe("runGatewayTurn", () => {
  it("accumulates text deltas and captures stop_reason for a no-tool turn", async () => {
    // Two text deltas to prove accumulation.
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        "event: message_start\ndata: {}\n\n",
        'event: text_delta\ndata: {"delta":"你好，"}\n\n',
        'event: text_delta\ndata: {"delta":"我能帮你"}\n\n',
        'event: message_delta\ndata: {"stop_reason":"end_turn"}\n\n',
      ]),
    );
    const messages: GatewayMessage[] = [{ role: "user", content: "hi" }];
    const turn = await runGatewayTurn(
      messages,
      "conv-1",
      baseOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(turn.text).toBe("你好，我能帮你");
    expect(turn.toolCalls).toEqual([]);
    expect(turn.stopReason).toBe("end_turn");

    // Verify the request shape (stateless: full messages + conv_id, no system).
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://x:8080/v1/gateway/chat/completions");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.conv_id).toBe("conv-1");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("accumulates tool_use_input_delta by index into argsJson", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse(
        toolTurnChunks({
          id: "call_1",
          name: "commerce_create_order",
          argsParts: ['{"product', '":"sku-1"}'],
        }),
      ),
    );
    const turn = await runGatewayTurn(
      [{ role: "user", content: "买它" }],
      "conv-2",
      baseOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]).toEqual({
      id: "call_1",
      name: "commerce_create_order",
      argsJson: '{"product":"sku-1"}',
    });
    expect(turn.stopReason).toBe("tool_use");
  });

  it("throws on non-2xx gateway response", async () => {
    const fetchImpl = vi.fn(async () => sseResponse(["unused"], 500));
    await expect(
      runGatewayTurn(
        [{ role: "user", content: "x" }],
        "c",
        baseOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }),
      ),
    ).rejects.toThrow(/gateway endpoint 500/);
  });

  it("handles SSE events that straddle network read boundaries", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse(['event: text_delta\ndata: {"delta":', '"split"}\n\n']),
    );
    const turn = await runGatewayTurn(
      [{ role: "user", content: "x" }],
      "c",
      baseOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(turn.text).toBe("split");
  });
});

describe("execCommerceTool", () => {
  it("POSTs to /v1/commerce/<tool> with zero-trust headers + parsed body", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      captured = { url, init: init ?? {} };
      return textResponse(JSON.stringify({ result: { order_id: "o-1" }, is_error: false }));
    });
    const out = await execCommerceTool(
      { id: "call_1", name: "commerce_create_order", argsJson: '{"sku":"x"}' },
      baseOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    expect(captured).not.toBeNull();
    const { url, init } = captured!;
    expect(url).toBe("http://x:8080/v1/commerce/commerce_create_order");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Session-Token"]).toBe("8797479017");
    expect(headers["X-Channel"]).toBe("telegram");
    expect(JSON.parse(init.body as string)).toEqual({ sku: "x" });
    expect(out).toContain("order_id");
  });

  it("sends {} body when argsJson is empty or invalid", async () => {
    const fetchImpl = vi.fn(async (_url, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual({});
      return textResponse("{}");
    });
    await execCommerceTool(
      { id: "c", name: "commerce_list_catalog", argsJson: "" },
      baseOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await execCommerceTool(
      { id: "c", name: "commerce_list_catalog", argsJson: "not-json" },
      baseOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fail-soft: non-2xx (401) is fed back as an error tool result, not thrown", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "unauthorized", message: "invalid session token" }, 401),
    );
    const out = await execCommerceTool(
      { id: "c", name: "commerce_create_order", argsJson: "{}" },
      baseOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    const parsed = JSON.parse(out) as { error: string; detail: string };
    expect(parsed.error).toBe("commerce commerce_create_order 401");
    expect(parsed.detail).toContain("invalid session token");
  });

  it("fail-soft: network throw is fed back as a request_failed tool result", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const out = await execCommerceTool(
      { id: "c", name: "commerce_create_order", argsJson: "{}" },
      baseOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    const parsed = JSON.parse(out) as { error: string; detail: string };
    expect(parsed.error).toBe("commerce commerce_create_order request_failed");
    expect(parsed.detail).toContain("ECONNREFUSED");
  });
});

describe("runEdgeLoop", () => {
  it("returns the text directly when the first turn has no tool calls", async () => {
    const fetchImpl = vi.fn(async () => sseResponse(textTurnChunks("我们卖耳机")));
    const result = await runEdgeLoop(
      "你卖什么",
      "conv-1",
      baseOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(result).toEqual({ reply: "我们卖耳机", iterations: 1, hitMaxTurns: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("executes a commerce tool then loops to a final text turn", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      if (url.endsWith("/v1/gateway/chat/completions")) {
        const body = JSON.parse((init?.body as string) ?? "{}") as {
          messages: GatewayMessage[];
        };
        // Turn 1: no tool result yet → emit a tool call. Turn 2: tool result is
        // present in messages → emit final text.
        const hasToolResult = body.messages.some((m) => m.role === "tool");
        if (hasToolResult) {
          return sseResponse(textTurnChunks("订单已为你创建 ✅"));
        }
        return sseResponse(
          toolTurnChunks({
            id: "call_1",
            name: "commerce_create_order",
            argsParts: ['{"sku":"earbuds"}'],
          }),
        );
      }
      // commerce RPC
      return textResponse(JSON.stringify({ result: { order_id: "o-9" }, is_error: false }));
    });

    const result = await runEdgeLoop(
      "买一副耳机",
      "conv-2",
      baseOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    expect(result).toEqual({
      reply: "订单已为你创建 ✅",
      iterations: 2,
      hitMaxTurns: false,
    });

    // 3 calls: gateway (tool) → commerce → gateway (final).
    expect(calls.map((c) => c.url)).toEqual([
      "http://x:8080/v1/gateway/chat/completions",
      "http://x:8080/v1/commerce/commerce_create_order",
      "http://x:8080/v1/gateway/chat/completions",
    ]);

    // Commerce call carries the zero-trust session token + parsed input.
    const commerceCall = calls[1];
    const headers = commerceCall.init.headers as Record<string, string>;
    expect(headers["X-Session-Token"]).toBe("8797479017");
    expect(headers["X-Channel"]).toBe("telegram");
    expect(JSON.parse(commerceCall.init.body as string)).toEqual({ sku: "earbuds" });

    // The 2nd gateway turn must include the assistant tool_call + tool result.
    const finalGatewayBody = JSON.parse(calls[2].init.body as string) as {
      messages: GatewayMessage[];
    };
    const assistantMsg = finalGatewayBody.messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.tool_calls?.[0]).toMatchObject({
      id: "call_1",
      function: { name: "commerce_create_order", arguments: '{"sku":"earbuds"}' },
    });
    const toolMsg = finalGatewayBody.messages.find((m) => m.role === "tool");
    expect(toolMsg?.tool_call_id).toBe("call_1");
    expect(toolMsg?.content).toContain("order_id");
  });

  it("commerce 401 is fed back as an error tool result and the loop continues", async () => {
    let gatewayTurns = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/gateway/chat/completions")) {
        gatewayTurns += 1;
        const body = JSON.parse((init?.body as string) ?? "{}") as {
          messages: GatewayMessage[];
        };
        const toolMsg = body.messages.find((m) => m.role === "tool");
        if (toolMsg) {
          // Loop continued after the 401: the LLM sees the error and replies.
          expect(toolMsg.content).toContain("401");
          return sseResponse(textTurnChunks("抱歉，你似乎还没注册，请先 /register"));
        }
        return sseResponse(
          toolTurnChunks({
            id: "call_x",
            name: "commerce_create_order",
            argsParts: ["{}"],
          }),
        );
      }
      // commerce → 401
      return jsonResponse({ error: "unauthorized", message: "invalid session token" }, 401);
    });

    const result = await runEdgeLoop(
      "下单",
      "conv-3",
      baseOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    expect(gatewayTurns).toBe(2);
    expect(result.hitMaxTurns).toBe(false);
    expect(result.iterations).toBe(2);
    expect(result.reply).toContain("register");
  });

  it("caps at maxTurns when the LLM keeps calling tools", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/gateway/chat/completions")) {
        // Always request another tool → never terminates on its own.
        return sseResponse(
          toolTurnChunks({
            id: "call_loop",
            name: "commerce_list_catalog",
            argsParts: ["{}"],
            text: "查询中…",
          }),
        );
      }
      return textResponse(JSON.stringify({ result: [], is_error: false }));
    });

    const result = await runEdgeLoop(
      "无限循环",
      "conv-4",
      baseOpts({ fetchImpl: fetchImpl as unknown as typeof fetch, maxTurns: 3 }),
    );

    expect(result.hitMaxTurns).toBe(true);
    expect(result.iterations).toBe(3);
    // lastText from the final (capped) turn is surfaced.
    expect(result.reply).toBe("查询中…");

    // 3 gateway turns + 3 commerce calls = 6 fetches.
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("falls back to a placeholder reply when the capped turn produced no text", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/gateway/chat/completions")) {
        return sseResponse(
          toolTurnChunks({
            id: "call_loop",
            name: "commerce_list_catalog",
            argsParts: ["{}"],
            // no text
          }),
        );
      }
      return textResponse("[]");
    });
    const result = await runEdgeLoop(
      "x",
      "conv-5",
      baseOpts({ fetchImpl: fetchImpl as unknown as typeof fetch, maxTurns: 1 }),
    );
    expect(result.hitMaxTurns).toBe(true);
    expect(result.reply).toBe("(已达最大轮次)");
  });
});

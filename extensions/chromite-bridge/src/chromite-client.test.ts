import { describe, expect, it } from "vitest";
import { streamChromiteChat, type ChromiteEvent } from "./chromite-client.js";

/** Build a `Response` whose body is a stream of the given SSE chunks. */
function makeSseResponse(chunks: string[], status = 200): Response {
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

describe("streamChromiteChat", () => {
  it("parses a basic turn_started + text_delta + turn_completed sequence", async () => {
    const fetchImpl = async () =>
      makeSseResponse([
        'event: turn_started\ndata: {"turn_id":"t-1"}\n\n',
        'event: text_delta\ndata: {"turn_id":"t-1","delta":"hi"}\n\n',
        'event: text_delta\ndata: {"turn_id":"t-1","delta":" there"}\n\n',
        'event: turn_completed\ndata: {"turn_id":"t-1","iterations":1,"hit_max_turns":false}\n\n',
      ]);
    const gen = streamChromiteChat(
      { session_id: "s-1", user_msg: "hello" },
      { chromiteUrl: "http://x", fetchImpl },
    );
    const events: ChromiteEvent[] = [];
    for await (const ev of gen) events.push(ev);
    expect(events).toEqual([
      { type: "turn_started", turn_id: "t-1" },
      { type: "text_delta", turn_id: "t-1", delta: "hi" },
      { type: "text_delta", turn_id: "t-1", delta: " there" },
      {
        type: "turn_completed",
        turn_id: "t-1",
        iterations: 1,
        hit_max_turns: false,
      },
    ]);
  });

  it("handles tool_call + tool_result mid-stream", async () => {
    const fetchImpl = async () =>
      makeSseResponse([
        'event: tool_call\ndata: {"turn_id":"t","tool":"commerce_create_order","input":{}}\n\n',
        'event: tool_result\ndata: {"turn_id":"t","tool":"commerce_create_order","output":{"ok":true}}\n\n',
      ]);
    const events: ChromiteEvent[] = [];
    for await (const ev of streamChromiteChat(
      { session_id: "s", user_msg: "x" },
      { chromiteUrl: "http://x", fetchImpl },
    )) {
      events.push(ev);
    }
    expect(events[0]).toMatchObject({
      type: "tool_call",
      tool: "commerce_create_order",
    });
    expect(events[1]).toMatchObject({
      type: "tool_result",
      tool: "commerce_create_order",
      output: { ok: true },
    });
  });

  it("throws on non-2xx with body in error message", async () => {
    const fetchImpl = async () => makeSseResponse(["not used"], 500);
    const gen = streamChromiteChat(
      { session_id: "s", user_msg: "x" },
      { chromiteUrl: "http://x", fetchImpl },
    );
    await expect(async () => {
      for await (const _ of gen) {
        // drain
      }
    }).rejects.toThrow(/chromite chat endpoint 500/);
  });

  it("splits SSE chunks even when they straddle network reads", async () => {
    // Split one event across two read chunks.
    const fetchImpl = async () =>
      makeSseResponse(['event: text_delta\ndata: {"turn_id":"t",', '"delta":"hello"}\n\n']);
    const events: ChromiteEvent[] = [];
    for await (const ev of streamChromiteChat(
      { session_id: "s", user_msg: "x" },
      { chromiteUrl: "http://x", fetchImpl },
    )) {
      events.push(ev);
    }
    expect(events).toEqual([{ type: "text_delta", turn_id: "t", delta: "hello" }]);
  });

  it("ignores SSE comment lines (keep-alive)", async () => {
    const fetchImpl = async () =>
      makeSseResponse([":ka\n\n", 'event: error\ndata: {"message":"boom"}\n\n']);
    const events: ChromiteEvent[] = [];
    for await (const ev of streamChromiteChat(
      { session_id: "s", user_msg: "x" },
      { chromiteUrl: "http://x", fetchImpl },
    )) {
      events.push(ev);
    }
    expect(events).toEqual([{ type: "error", message: "boom" }]);
  });

  it("passes channel + channel_user_id when supplied (resolution-middleware-v1)", async () => {
    let receivedBody: unknown = null;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      receivedBody = JSON.parse(init?.body as string);
      return makeSseResponse([
        'event: turn_completed\ndata: {"turn_id":"t","iterations":0,"hit_max_turns":false}\n\n',
      ]);
    };
    const gen = streamChromiteChat(
      {
        session_id: "s-1",
        user_msg: "hello",
        channel: "telegram",
        channel_user_id: "8797479017",
      },
      { chromiteUrl: "http://x", fetchImpl: fetchImpl as typeof fetch },
    );
    for await (const _ of gen) {
      // drain
    }
    expect(receivedBody).toEqual({
      session_id: "s-1",
      user_msg: "hello",
      channel: "telegram",
      channel_user_id: "8797479017",
    });
  });

  it("omits channel fields when not supplied (backward compat)", async () => {
    let receivedBody: unknown = null;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      receivedBody = JSON.parse(init?.body as string);
      return makeSseResponse([
        'event: turn_completed\ndata: {"turn_id":"t","iterations":0,"hit_max_turns":false}\n\n',
      ]);
    };
    const gen = streamChromiteChat(
      { session_id: "s-1", user_msg: "hello" },
      { chromiteUrl: "http://x", fetchImpl: fetchImpl as typeof fetch },
    );
    for await (const _ of gen) {
      // drain
    }
    const body = receivedBody as Record<string, unknown>;
    expect(body.session_id).toBe("s-1");
    expect(body.user_msg).toBe("hello");
    expect("channel" in body).toBe(false);
    expect("channel_user_id" in body).toBe(false);
  });
});

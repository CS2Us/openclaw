import type {
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
} from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import type { BridgeHandlerInput, BridgeHandlerResult } from "./handler.js";
import { createChromiteBridgeInboundClaimHandler } from "./inbound-claim.js";

function makeEvent(
  overrides: Partial<PluginHookInboundClaimEvent> = {},
): PluginHookInboundClaimEvent {
  return {
    channel: "telegram",
    content: "你好",
    bodyForAgent: "你好",
    isGroup: false,
    senderId: "12345",
    conversationId: "12345",
    accountId: "default",
    commandAuthorized: false,
    ...overrides,
  };
}

const ctx: PluginHookInboundClaimContext = {} as PluginHookInboundClaimContext;

function makeDispatcher(
  reply = "hi there",
): (input: BridgeHandlerInput) => Promise<BridgeHandlerResult> {
  return vi.fn().mockResolvedValue({ reply, sessionId: "ses_test" });
}

describe("createChromiteBridgeInboundClaimHandler", () => {
  it("claims a plain telegram DM and dispatches to chromite-server", async () => {
    const dispatcher = makeDispatcher("res");
    const handler = createChromiteBridgeInboundClaimHandler({ dispatcher });
    const result = await handler(makeEvent(), ctx);
    expect(result).toEqual({ handled: true, reply: { text: "res" } });
    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(dispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "12345",
        senderId: "12345",
        text: "你好",
        accountId: "default",
      }),
    );
  });

  it("preserves interactive checkout buttons in the claimed reply payload", async () => {
    const interactive = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [
            {
              label: "确认支付",
              value: "/chromite-pay op_test",
              style: "primary" as const,
            },
          ],
        },
      ],
    };
    const dispatcher = vi.fn().mockResolvedValue({
      reply: "请确认支付",
      sessionId: "ses_test",
      interactive,
    } satisfies BridgeHandlerResult);
    const handler = createChromiteBridgeInboundClaimHandler({ dispatcher });

    const result = await handler(makeEvent(), ctx);

    expect(result).toEqual({
      handled: true,
      reply: {
        text: "请确认支付",
        interactive,
      },
    });
  });

  it("does NOT claim when channel != telegram (lets other plugins handle)", async () => {
    const dispatcher = makeDispatcher();
    const handler = createChromiteBridgeInboundClaimHandler({ dispatcher });
    const result = await handler(makeEvent({ channel: "discord" }), ctx);
    expect(result).toBeUndefined();
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("does NOT claim group chats (v1 is 1-on-1 DM only)", async () => {
    const dispatcher = makeDispatcher();
    const handler = createChromiteBridgeInboundClaimHandler({ dispatcher });
    const result = await handler(makeEvent({ isGroup: true }), ctx);
    expect(result).toBeUndefined();
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("does NOT claim when commandAuthorized=true (lets /chromite etc. handle)", async () => {
    const dispatcher = makeDispatcher();
    const handler = createChromiteBridgeInboundClaimHandler({ dispatcher });
    const result = await handler(makeEvent({ commandAuthorized: true }), ctx);
    expect(result).toBeUndefined();
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("does NOT claim when text body is empty (nothing to dispatch)", async () => {
    const dispatcher = makeDispatcher();
    const handler = createChromiteBridgeInboundClaimHandler({ dispatcher });
    const result = await handler(makeEvent({ bodyForAgent: "   ", content: "" }), ctx);
    expect(result).toBeUndefined();
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("falls back to content when bodyForAgent missing", async () => {
    const dispatcher = makeDispatcher("ok");
    const handler = createChromiteBridgeInboundClaimHandler({ dispatcher });
    const event = makeEvent({ content: "raw msg" });
    delete (event as { bodyForAgent?: string }).bodyForAgent;
    const result = await handler(event, ctx);
    expect(result).toEqual({ handled: true, reply: { text: "ok" } });
    expect(dispatcher).toHaveBeenCalledWith(expect.objectContaining({ text: "raw msg" }));
  });

  it("returns handled=true with error text when dispatcher throws (no silent drop)", async () => {
    const dispatcher = vi.fn().mockRejectedValue(new Error("chromite down"));
    const handler = createChromiteBridgeInboundClaimHandler({ dispatcher });
    const result = await handler(makeEvent(), ctx);
    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toContain("chromite-bridge: dispatch failed");
    expect(result?.reply?.text).toContain("chromite down");
  });

  it("uses senderId when conversationId missing", async () => {
    const dispatcher = makeDispatcher();
    const handler = createChromiteBridgeInboundClaimHandler({ dispatcher });
    const event = makeEvent();
    delete (event as { conversationId?: string }).conversationId;
    await handler(event, ctx);
    expect(dispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "12345", senderId: "12345" }),
    );
  });

  it("does NOT claim when both conversationId and senderId missing (no chat to reply to)", async () => {
    const dispatcher = makeDispatcher();
    const handler = createChromiteBridgeInboundClaimHandler({ dispatcher });
    const event = makeEvent();
    delete (event as { conversationId?: string }).conversationId;
    delete (event as { senderId?: string }).senderId;
    const result = await handler(event, ctx);
    expect(result).toBeUndefined();
    expect(dispatcher).not.toHaveBeenCalled();
  });
});

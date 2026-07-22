import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createForumTopic,
  deleteMessage,
  editMessageText,
  sendBotMessage,
  sendTypingAction,
} from "./telegram-bot-api.js";

type FetchCall = { url: string; body: Record<string, unknown> };

function stubFetch(impl: (call: FetchCall) => { status: number; body: unknown }): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const call: FetchCall = { url, body };
      calls.push(call);
      const { status, body: respBody } = impl(call);
      return new Response(JSON.stringify(respBody), { status });
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendBotMessage", () => {
  it("forwards messageThreadId into the Telegram API payload", async () => {
    const calls = stubFetch(() => ({
      status: 200,
      body: { ok: true, result: { message_id: 42, chat: { id: -1001234 } } },
    }));
    const result = await sendBotMessage({
      botToken: "TOKEN",
      chatId: "-1001234",
      text: "hello",
      messageThreadId: 9,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.telegram.org/botTOKEN/sendMessage");
    expect(calls[0]?.body).toMatchObject({
      chat_id: "-1001234",
      text: "hello",
      message_thread_id: 9,
      disable_web_page_preview: true,
    });
  });

  it("omits message_thread_id when no thread is given", async () => {
    const calls = stubFetch(() => ({
      status: 200,
      body: { ok: true, result: { message_id: 1, chat: { id: 5 } } },
    }));
    await sendBotMessage({ botToken: "T", chatId: "5", text: "x" });
    expect(calls[0]?.body).not.toHaveProperty("message_thread_id");
  });

  it("returns ok=false on missing token without hitting fetch", async () => {
    const calls = stubFetch(() => ({ status: 200, body: { ok: true } }));
    const result = await sendBotMessage({ botToken: "", chatId: "1", text: "x" });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("returns ok=false with description when Telegram returns a non-ok body", async () => {
    stubFetch(() => ({
      status: 400,
      body: { ok: false, description: "chat not found", error_code: 400 },
    }));
    const result = await sendBotMessage({ botToken: "T", chatId: "1", text: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.description).toBe("chat not found");
    }
  });

  it("attaches reply_markup when buttons are provided", async () => {
    const calls = stubFetch(() => ({
      status: 200,
      body: { ok: true, result: { message_id: 1, chat: { id: 5 } } },
    }));
    await sendBotMessage({
      botToken: "T",
      chatId: "5",
      text: "x",
      replyMarkup: {
        inline_keyboard: [[{ text: "yes", callback_data: "y" }]],
      },
    });
    expect(calls[0]?.body).toMatchObject({
      reply_markup: { inline_keyboard: [[{ text: "yes", callback_data: "y" }]] },
    });
  });
});

describe("editMessageText", () => {
  it("hits editMessageText endpoint with chat_id + message_id", async () => {
    const calls = stubFetch(() => ({
      status: 200,
      body: { ok: true, result: { message_id: 42, chat: { id: 5 } } },
    }));
    const result = await editMessageText({
      botToken: "T",
      chatId: "5",
      messageId: 42,
      text: "updated",
    });
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("https://api.telegram.org/botT/editMessageText");
    expect(calls[0]?.body).toMatchObject({
      chat_id: "5",
      message_id: 42,
      text: "updated",
      disable_web_page_preview: true,
    });
  });

  it("forwards reply_markup so buttons stay attached", async () => {
    const calls = stubFetch(() => ({
      status: 200,
      body: { ok: true, result: { message_id: 1, chat: { id: 5 } } },
    }));
    await editMessageText({
      botToken: "T",
      chatId: "5",
      messageId: 1,
      text: "x",
      replyMarkup: { inline_keyboard: [[{ text: "go", callback_data: "g" }]] },
    });
    expect(calls[0]?.body).toMatchObject({
      reply_markup: { inline_keyboard: [[{ text: "go", callback_data: "g" }]] },
    });
  });

  it("returns ok=false with description when message is gone", async () => {
    stubFetch(() => ({
      status: 400,
      body: {
        ok: false,
        description: "Bad Request: message to edit not found",
        error_code: 400,
      },
    }));
    const result = await editMessageText({
      botToken: "T",
      chatId: "5",
      messageId: 999,
      text: "x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.description).toContain("message to edit not found");
    }
  });
});

describe("deleteMessage", () => {
  it("calls deleteMessage with chat_id + message_id", async () => {
    const calls = stubFetch(() => ({
      status: 200,
      body: { ok: true, result: true },
    }));
    const result = await deleteMessage({ botToken: "T", chatId: "5", messageId: 42 });
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("https://api.telegram.org/botT/deleteMessage");
    expect(calls[0]?.body).toEqual({ chat_id: "5", message_id: 42 });
  });

  it("returns ok=false when Telegram refuses", async () => {
    stubFetch(() => ({
      status: 400,
      body: {
        ok: false,
        description: "Bad Request: message can't be deleted",
        error_code: 400,
      },
    }));
    const result = await deleteMessage({ botToken: "T", chatId: "5", messageId: 999 });
    expect(result.ok).toBe(false);
  });
});

describe("sendTypingAction", () => {
  it("forwards messageThreadId when provided", async () => {
    const calls = stubFetch(() => ({ status: 200, body: { ok: true, result: true } }));
    await sendTypingAction({
      botToken: "T",
      chatId: "-100",
      messageThreadId: 7,
    });
    expect(calls[0]?.url).toBe("https://api.telegram.org/botT/sendChatAction");
    expect(calls[0]?.body).toMatchObject({
      chat_id: "-100",
      action: "typing",
      message_thread_id: 7,
    });
  });

  it("silently no-ops on missing token", async () => {
    const calls = stubFetch(() => ({ status: 200, body: { ok: true } }));
    await sendTypingAction({ botToken: "", chatId: "1" });
    expect(calls).toHaveLength(0);
  });
});

describe("createForumTopic", () => {
  it("returns the new thread id on success", async () => {
    stubFetch(() => ({
      status: 200,
      body: { ok: true, result: { message_thread_id: 33, name: "demo" } },
    }));
    const result = await createForumTopic({
      botToken: "T",
      chatId: "-100",
      name: "demo",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messageThreadId).toBe(33);
      expect(result.name).toBe("demo");
    }
  });

  it("forwards optional iconColor", async () => {
    const calls = stubFetch(() => ({
      status: 200,
      body: { ok: true, result: { message_thread_id: 1, name: "x" } },
    }));
    await createForumTopic({
      botToken: "T",
      chatId: "-100",
      name: "x",
      iconColor: 0x6fb9f0,
    });
    expect(calls[0]?.body).toMatchObject({ name: "x", icon_color: 0x6fb9f0 });
  });

  it("rejects empty topic name without hitting fetch", async () => {
    const calls = stubFetch(() => ({ status: 200, body: { ok: true } }));
    const result = await createForumTopic({
      botToken: "T",
      chatId: "-100",
      name: "   ",
    });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("returns ok=false on Telegram error response", async () => {
    stubFetch(() => ({
      status: 400,
      body: {
        ok: false,
        description: "Bad Request: not enough rights to manage topics",
        error_code: 400,
      },
    }));
    const result = await createForumTopic({
      botToken: "T",
      chatId: "-100",
      name: "demo",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.description).toContain("not enough rights");
    }
  });
});

import type { InteractiveReplyBlock } from "openclaw/plugin-sdk/interactive-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverPanel } from "./panel-delivery.js";
import {
  getPanelId,
  resetPanelIdStoreForTesting,
  setPanelId,
  setPanelIdStoreForTesting,
} from "./panel-id-store.js";

type FetchCall = { url: string; body: Record<string, unknown> };

function stubFetch(handler: (call: FetchCall) => { status?: number; body: unknown }): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const call: FetchCall = { url, body };
      calls.push(call);
      const { status, body: respBody } = handler(call);
      return new Response(JSON.stringify(respBody), { status: status ?? 200 });
    }),
  );
  return calls;
}

const BUTTON_BLOCKS: InteractiveReplyBlock[] = [
  {
    type: "buttons",
    buttons: [
      { label: "Switch", value: "cb:switch" },
      { label: "Follow", value: "cb:follow" },
    ],
  },
];

beforeEach(() => {
  resetPanelIdStoreForTesting();
  setPanelIdStoreForTesting(null); // no persistent store; in-memory only
  vi.unstubAllGlobals();
});

afterEach(() => {
  resetPanelIdStoreForTesting();
  vi.unstubAllGlobals();
});

describe("deliverPanel", () => {
  it("sends fresh when no prior panel exists and records the new id", async () => {
    const calls = stubFetch(() => ({
      body: { ok: true, result: { message_id: 77, chat: { id: 5 } } },
    }));
    await deliverPanel({
      chatKey: "telegram:5",
      chatId: "5",
      botToken: "T",
      text: "panel content",
      blocks: BUTTON_BLOCKS,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.telegram.org/botT/sendMessage");
    expect(calls[0]?.body).toMatchObject({
      chat_id: "5",
      text: "panel content",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Switch", callback_data: "cb:switch" },
            { text: "Follow", callback_data: "cb:follow" },
          ],
        ],
      },
    });
    expect(getPanelId("telegram:5")?.messageId).toBe(77);
  });

  it("edits the existing panel in place when ids match", async () => {
    setPanelId("telegram:5", { chatId: "5", messageId: 99, updatedAt: 0 });
    const calls = stubFetch(() => ({
      body: { ok: true, result: { message_id: 99, chat: { id: 5 } } },
    }));
    await deliverPanel({
      chatKey: "telegram:5",
      chatId: "5",
      botToken: "T",
      text: "updated",
      blocks: BUTTON_BLOCKS,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.telegram.org/botT/editMessageText");
    expect(calls[0]?.body).toMatchObject({ message_id: 99, text: "updated" });
    expect(getPanelId("telegram:5")?.messageId).toBe(99);
  });

  it("falls back to send + delete-stale when edit returns 'message to edit not found'", async () => {
    setPanelId("telegram:5", { chatId: "5", messageId: 99, updatedAt: 0 });
    const calls = stubFetch((call) => {
      if (call.url.endsWith("/editMessageText")) {
        return {
          status: 400,
          body: {
            ok: false,
            description: "Bad Request: message to edit not found",
            error_code: 400,
          },
        };
      }
      if (call.url.endsWith("/sendMessage")) {
        return { body: { ok: true, result: { message_id: 200, chat: { id: 5 } } } };
      }
      // deleteMessage of the stale id; might or might not succeed — fine.
      return { body: { ok: true, result: true } };
    });
    await deliverPanel({
      chatKey: "telegram:5",
      chatId: "5",
      botToken: "T",
      text: "panel content",
      blocks: BUTTON_BLOCKS,
    });
    // Order: edit (fail) → send (ok) → deleteMessage of stale id (fire-and-forget)
    expect(calls[0]?.url).toBe("https://api.telegram.org/botT/editMessageText");
    expect(calls[1]?.url).toBe("https://api.telegram.org/botT/sendMessage");
    // Allow microtask flush for the fire-and-forget delete
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.some((c) => c.url.endsWith("/deleteMessage") && c.body.message_id === 99)).toBe(
      true,
    );
    expect(getPanelId("telegram:5")?.messageId).toBe(200);
  });

  it("keeps the panel id when edit returns 'message is not modified' (benign)", async () => {
    setPanelId("telegram:5", { chatId: "5", messageId: 99, updatedAt: 0 });
    const calls = stubFetch(() => ({
      status: 400,
      body: {
        ok: false,
        description: "Bad Request: message is not modified",
        error_code: 400,
      },
    }));
    await deliverPanel({
      chatKey: "telegram:5",
      chatId: "5",
      botToken: "T",
      text: "same",
      blocks: BUTTON_BLOCKS,
    });
    // Only the edit call — no follow-up send because we treat 'not modified' as success.
    expect(calls).toHaveLength(1);
    expect(getPanelId("telegram:5")?.messageId).toBe(99);
  });

  it("does not delete the prior id when send-fresh fails (leaves stale state intact)", async () => {
    setPanelId("telegram:5", { chatId: "5", messageId: 99, updatedAt: 0 });
    stubFetch((call) => {
      if (call.url.endsWith("/editMessageText")) {
        return {
          status: 400,
          body: {
            ok: false,
            description: "Bad Request: message to edit not found",
            error_code: 400,
          },
        };
      }
      return {
        status: 500,
        body: { ok: false, description: "Internal Server Error", error_code: 500 },
      };
    });
    await deliverPanel({
      chatKey: "telegram:5",
      chatId: "5",
      botToken: "T",
      text: "x",
      blocks: BUTTON_BLOCKS,
    });
    // Edit failed AND send failed: keep the prior id so the next attempt can retry.
    expect(getPanelId("telegram:5")?.messageId).toBe(99);
  });

  it("treats panel id from a different chat as no prior panel and sends fresh", async () => {
    setPanelId("telegram:5", { chatId: "OTHER", messageId: 99, updatedAt: 0 });
    const calls = stubFetch(() => ({
      body: { ok: true, result: { message_id: 1, chat: { id: 5 } } },
    }));
    await deliverPanel({
      chatKey: "telegram:5",
      chatId: "5",
      botToken: "T",
      text: "x",
      blocks: BUTTON_BLOCKS,
    });
    expect(calls[0]?.url).toBe("https://api.telegram.org/botT/sendMessage");
    expect(getPanelId("telegram:5")?.messageId).toBe(1);
  });
});

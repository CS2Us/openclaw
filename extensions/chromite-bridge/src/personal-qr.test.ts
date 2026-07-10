// C-lite personal QR wiring tests — spec chromite-personal-qr-openclaw-wiring-v1.

import type {
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
} from "openclaw/plugin-sdk/plugin-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChromiteBridgeInboundClaimHandler } from "./inbound-claim.js";
import { decorateReplyWithProjection } from "./personal-qr-render.js";
import {
  clearPendingPayOperations,
  PERSONAL_QR_PROFILE,
  renderProjection,
  type ClientAction,
} from "./projection-engine.js";
import { handleQrUpload, matchQrUploadRequest, QR_UPLOAD_MAX_BYTES } from "./qr-upload.js";

const PRINCIPAL = { accountId: "default", senderId: "12345" };

function personalQrAction(
  presentationOverrides: Record<string, unknown> = {},
  projectionOverrides: Record<string, unknown> = {},
): ClientAction {
  return {
    kind: "interaction_projection",
    version: 1,
    projection: {
      id: "ip_qr",
      domain: "commerce",
      surface: "checkout",
      entity: {
        type: "payment_intent",
        id: "pi_x",
        state: "awaiting_external_payment",
        refs: { order_id: "ord_x", payment_id: "pay_x" },
      },
      presentation: {
        profile: PERSONAL_QR_PROFILE,
        layout: "confirmation_card",
        amount: { value_cents: 4200, currency: "cny" },
        seller_payment: {
          mode: "personal_qr_clite",
          qr_ref: "0b5a1c9e-6f2d-4f7a-9e2b-000000000001",
          qr_content_type: "image/png",
          instructions: "请扫码向卖家直接付款；卖家确认收款后订单继续推进。",
        },
        ...presentationOverrides,
      },
      actions: [],
      operations: {},
      ...projectionOverrides,
    },
  };
}

describe("renderProjection (minimal profile dispatch)", () => {
  beforeEach(() => {
    clearPendingPayOperations();
  });

  it("maps a personal_qr projection to a render descriptor", () => {
    const render = renderProjection([personalQrAction()], PRINCIPAL);
    expect(render).toEqual({
      kind: "personal_qr",
      qrRef: "0b5a1c9e-6f2d-4f7a-9e2b-000000000001",
      contentType: "image/png",
      instructions: "请扫码向卖家直接付款；卖家确认收款后订单继续推进。",
      amountCents: 4200,
    });
  });

  it("degrades a malformed personal_qr projection to unsupported (no guessing)", () => {
    const missingRef = personalQrAction({
      seller_payment: { mode: "personal_qr_clite" },
    });
    expect(renderProjection([missingRef], PRINCIPAL)).toEqual({
      kind: "unsupported",
      profile: PERSONAL_QR_PROFILE,
    });

    const wrongMode = personalQrAction({
      seller_payment: { mode: "something_else", qr_ref: "ref" },
    });
    expect(renderProjection([wrongMode], PRINCIPAL)).toEqual({
      kind: "unsupported",
      profile: PERSONAL_QR_PROFILE,
    });
  });

  it("degrades an unknown non-empty profile to unsupported instead of silence", () => {
    const unknown = personalQrAction({
      profile: "checkout.payment.future_thing.v9",
      seller_payment: undefined,
    });
    expect(renderProjection([unknown], PRINCIPAL)).toEqual({
      kind: "unsupported",
      profile: "checkout.payment.future_thing.v9",
    });
  });

  it("returns none when there is no interaction projection", () => {
    expect(renderProjection([], PRINCIPAL)).toEqual({ kind: "none" });
    expect(renderProjection(undefined, PRINCIPAL)).toEqual({ kind: "none" });
  });
});

describe("decorateReplyWithProjection (personal_qr)", () => {
  const render = {
    kind: "personal_qr",
    qrRef: "0b5a1c9e-6f2d-4f7a-9e2b-000000000001",
    contentType: "image/png",
    instructions: "请扫码向卖家直接付款；卖家确认收款后订单继续推进。",
    amountCents: 4200,
  } as const;

  it("attaches the QR media URL and instructions when the image is fetchable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    const out = await decorateReplyWithProjection({
      reply: "订单已创建",
      render,
      chromiteUrl: "http://127.0.0.1:8080/",
      fetchImpl,
    });
    expect(out.mediaUrl).toBe(
      "http://127.0.0.1:8080/v1/commerce/seller-payment-qr/0b5a1c9e-6f2d-4f7a-9e2b-000000000001",
    );
    expect(out.sensitiveMedia).toBe(true);
    expect(out.buttons).toBeNull();
    expect(out.reply).toContain("应付金额：¥42.00");
    expect(out.reply).toContain("请扫码向卖家直接付款");
  });

  it("fails visible (text notice, no media) when the QR image cannot be fetched", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
    const out = await decorateReplyWithProjection({
      reply: "订单已创建",
      render,
      chromiteUrl: "http://127.0.0.1:8080",
      fetchImpl,
    });
    expect(out.mediaUrl).toBeUndefined();
    expect(out.reply).toContain("收款码加载失败");
  });

  it("appends a degrade notice for unsupported profiles", async () => {
    const out = await decorateReplyWithProjection({
      reply: "hi",
      render: { kind: "unsupported", profile: "x.y.v9" },
      chromiteUrl: "http://127.0.0.1:8080",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(out.reply).toContain("x.y.v9");
    expect(out.reply).toContain("暂不支持显示");
  });

  it("passes buttons and plain replies through untouched", async () => {
    const block = { type: "buttons" as const, buttons: [{ label: "确认支付", value: "/x t" }] };
    const buttons = await decorateReplyWithProjection({
      reply: "hi",
      render: { kind: "buttons", block },
      chromiteUrl: "http://127.0.0.1:8080",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(buttons).toEqual({ reply: "hi", buttons: block });

    const none = await decorateReplyWithProjection({
      reply: "hi",
      render: { kind: "none" },
      chromiteUrl: "http://127.0.0.1:8080",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(none).toEqual({ reply: "hi", buttons: null });
  });
});

describe("matchQrUploadRequest", () => {
  it("matches photo + caption /chromite-qr and extracts host-downloaded media", () => {
    expect(
      matchQrUploadRequest({
        content: "/chromite-qr",
        metadata: { mediaPath: "/tmp/qr.png", mediaType: "image" },
      }),
    ).toEqual({ mediaPath: "/tmp/qr.png" });
  });

  it("matches caption without media (caller replies usage)", () => {
    expect(matchQrUploadRequest({ content: "/chromite-qr" })).toEqual({});
  });

  it("ignores other messages", () => {
    expect(matchQrUploadRequest({ content: "你好" })).toBeNull();
    expect(matchQrUploadRequest({ content: "/chromite 买东西" })).toBeNull();
    expect(matchQrUploadRequest({ content: "" })).toBeNull();
  });
});

describe("inbound_claim QR upload early branch", () => {
  const ctx = {} as PluginHookInboundClaimContext;

  function qrEvent(
    overrides: Partial<PluginHookInboundClaimEvent> = {},
  ): PluginHookInboundClaimEvent {
    return {
      channel: "telegram",
      content: "/chromite-qr",
      isGroup: false,
      senderId: "8797479017",
      conversationId: "8797479017",
      accountId: "default",
      metadata: { mediaPath: "/tmp/qr.png", mediaType: "image" },
      ...overrides,
    };
  }

  it("claims photo + /chromite-qr caption and replies the upload receipt", async () => {
    const qrUploader = vi.fn().mockResolvedValue("✅ 收款码已更新（image/png）。");
    const handler = createChromiteBridgeInboundClaimHandler({ qrUploader });
    const result = await handler(qrEvent(), ctx);
    expect(result).toEqual({ handled: true, reply: { text: "✅ 收款码已更新（image/png）。" } });
    expect(qrUploader).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: "8797479017",
        request: { mediaPath: "/tmp/qr.png" },
      }),
    );
  });

  it("claims even when the caption parses as command-like (branch precedes the command guard)", async () => {
    const qrUploader = vi.fn().mockResolvedValue("ok");
    const handler = createChromiteBridgeInboundClaimHandler({ qrUploader });
    const result = await handler(qrEvent({ commandAuthorized: true }), ctx);
    expect(result).toEqual({ handled: true, reply: { text: "ok" } });
  });

  it("does not claim ordinary messages via the QR branch", async () => {
    const qrUploader = vi.fn();
    const dispatcher = vi.fn().mockResolvedValue({ reply: "hi", sessionId: "s" });
    const handler = createChromiteBridgeInboundClaimHandler({ qrUploader, dispatcher });
    await handler(qrEvent({ content: "你好", bodyForAgent: "你好", metadata: {} }), ctx);
    expect(qrUploader).not.toHaveBeenCalled();
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });
});

describe("handleQrUpload", () => {
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

  function jsonResponse(status: number, body: Record<string, unknown>) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }

  it("uploads the photo bytes and returns a success receipt", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { content_type: "image/png" }));
    const readFileImpl = vi.fn().mockResolvedValue(PNG_BYTES);
    const receipt = await handleQrUpload({
      senderId: "8797479017",
      request: { mediaPath: "/tmp/qr.png" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readFileImpl,
    });
    expect(receipt).toContain("收款码已更新");
    expect(receipt).toContain("image/png");
    const [url, init] = fetchImpl.mock.calls[0] as [string, { body: string }];
    expect(url).toContain("/v1/sellers/payment-qr");
    const payload = JSON.parse(init.body) as { seller_id: string; image_base64: string };
    expect(payload.seller_id).toBe("8797479017");
    expect(Buffer.from(payload.image_base64, "base64")).toEqual(PNG_BYTES);
  });

  it("passes through chromite's 403 rbac message", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(403, { error: "not_seller", message: "你不是登记的卖家，无权上传收款码" }),
      );
    const receipt = await handleQrUpload({
      senderId: "999",
      request: { mediaPath: "/tmp/qr.png" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readFileImpl: vi.fn().mockResolvedValue(PNG_BYTES),
    });
    expect(receipt).toBe("你不是登记的卖家，无权上传收款码");
  });

  it("maps 400 to a format/size hint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: "InvalidImage" }));
    const receipt = await handleQrUpload({
      senderId: "8797479017",
      request: { mediaPath: "/tmp/qr.gif" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readFileImpl: vi.fn().mockResolvedValue(Buffer.from("GIF89a")),
    });
    expect(receipt).toContain("格式不支持或过大");
  });

  it("rejects oversized photos client-side without calling chromite", async () => {
    const fetchImpl = vi.fn();
    const receipt = await handleQrUpload({
      senderId: "8797479017",
      request: { mediaPath: "/tmp/huge.png" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readFileImpl: vi.fn().mockResolvedValue(Buffer.alloc(QR_UPLOAD_MAX_BYTES + 1)),
    });
    expect(receipt).toContain("图片过大");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("replies usage when the caption matched but no photo came along", async () => {
    const fetchImpl = vi.fn();
    const receipt = await handleQrUpload({
      senderId: "8797479017",
      request: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(receipt).toContain("用法");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

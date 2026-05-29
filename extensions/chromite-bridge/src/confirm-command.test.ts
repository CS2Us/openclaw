import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createConfirmCommand } from "./confirm-command.js";

function makeCtx(overrides: Partial<PluginCommandContext> = {}): PluginCommandContext {
  return {
    senderId: overrides.senderId ?? "12345",
    channel: "telegram",
    isAuthorizedSender: true,
    commandBody: "/confirm o1 p1",
    args: "o1 p1",
    config: {} as PluginCommandContext["config"],
    requestConversationBinding: async () =>
      ({
        granted: false,
      }) as Awaited<ReturnType<PluginCommandContext["requestConversationBinding"]>>,
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createConfirmCommand", () => {
  // rbac-v1: openclaw 不再本地白名单校验 —— 鉴权下沉到 chromite (users.role)。
  it("forwards any senderId to chromite (no local whitelist)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ payment_state: "Success", order_state: "Paid", already_confirmed: false }),
    );
    const cmd = createConfirmCommand({ pluginConfig: {}, fetchImpl });
    const result = (await cmd.handler(
      makeCtx({ senderId: "11111", args: "o p" }),
    )) as PluginCommandResult;
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.seller_id).toBe("11111");
    expect(result.reply).toContain("✅");
  });

  it("surfaces chromite 403 not_seller message (no HTTP noise)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: "not_seller", message: "你不是登记的卖家，无权使用 /confirm 命令" },
        403,
      ),
    );
    const cmd = createConfirmCommand({ pluginConfig: {}, fetchImpl });
    const result = (await cmd.handler(makeCtx({ args: "o p" }))) as PluginCommandResult;
    expect(result.reply).toContain("不是登记的卖家");
    expect(result.reply).not.toContain("HTTP");
  });

  it("surfaces chromite 403 unregistered message", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          error: "unregistered",
          message: "你还没在 chromite 注册，无法确认收款（请先注册卖家身份）",
        },
        403,
      ),
    );
    const cmd = createConfirmCommand({ pluginConfig: {}, fetchImpl });
    const result = (await cmd.handler(makeCtx({ args: "o p" }))) as PluginCommandResult;
    expect(result.reply).toContain("还没在 chromite 注册");
  });

  it("returns usage when args missing both IDs", async () => {
    const cmd = createConfirmCommand({
      pluginConfig: { sellerTelegramUserIds: ["12345"] },
      fetchImpl: vi.fn(),
    });
    const result = (await cmd.handler(makeCtx({ args: "" }))) as PluginCommandResult;
    expect(result.reply).toContain("用法");
    expect(result.reply).toContain("/confirm");
  });

  it("returns usage when only one ID provided", async () => {
    const cmd = createConfirmCommand({
      pluginConfig: { sellerTelegramUserIds: ["12345"] },
      fetchImpl: vi.fn(),
    });
    const result = (await cmd.handler(makeCtx({ args: "only-one" }))) as PluginCommandResult;
    expect(result.reply).toContain("用法");
  });

  it("posts to chromite manual-confirm and reports Success/Paid on 200", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        payment_state: "Success",
        order_state: "Paid",
        already_confirmed: false,
        dispatch_errors: [],
      }),
    );
    const cmd = createConfirmCommand({
      pluginConfig: {
        sellerTelegramUserIds: ["12345"],
        chromiteUrl: "http://test:8080",
      },
      fetchImpl,
    });
    const result = (await cmd.handler(makeCtx({ args: "o_test p_test" }))) as PluginCommandResult;

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://test:8080/v1/commerce/manual-confirm");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.order_id).toBe("o_test");
    expect(body.payment_id).toBe("p_test");
    expect(body.seller_id).toBe("12345");

    expect(result.reply).toContain("✅");
    expect(result.reply).toContain("Payment=Success");
    expect(result.reply).toContain("Order=Paid");
  });

  it("annotates idempotent (already_confirmed) replies", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        payment_state: "Success",
        order_state: "Paid",
        already_confirmed: true,
        dispatch_errors: [],
      }),
    );
    const cmd = createConfirmCommand({
      pluginConfig: { sellerTelegramUserIds: ["12345"] },
      fetchImpl,
    });
    const result = (await cmd.handler(makeCtx({ args: "o_idem p_idem" }))) as PluginCommandResult;
    expect(result.reply).toContain("重复调用");
  });

  it("reports chromite 4xx error with kind + message", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          error: "OrderNotFound",
          message: "order o_ghost not found",
        },
        404,
      ),
    );
    const cmd = createConfirmCommand({
      pluginConfig: { sellerTelegramUserIds: ["12345"] },
      fetchImpl,
    });
    const result = (await cmd.handler(makeCtx({ args: "o_ghost p_ghost" }))) as PluginCommandResult;
    expect(result.reply).toContain("❌");
    expect(result.reply).toContain("OrderNotFound");
    expect(result.reply).toContain("not found");
  });

  it("handles network failure gracefully", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const cmd = createConfirmCommand({
      pluginConfig: { sellerTelegramUserIds: ["12345"] },
      fetchImpl,
    });
    const result = (await cmd.handler(makeCtx({ args: "o p" }))) as PluginCommandResult;
    expect(result.reply).toContain("❌");
    expect(result.reply).toContain("ECONNREFUSED");
  });
});

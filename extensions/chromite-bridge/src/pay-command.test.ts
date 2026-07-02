import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPayCommand } from "./pay-command.js";
import {
  buildInteractionButtons,
  clearPendingPayOperations,
  type ClientAction,
} from "./projection-engine.js";

function makeCtx(overrides: Partial<PluginCommandContext> = {}): PluginCommandContext {
  return {
    senderId: overrides.senderId ?? "12345",
    channel: "telegram",
    isAuthorizedSender: true,
    commandBody: "/chromite-pay token",
    args: "token",
    config: {} as PluginCommandContext["config"],
    requestConversationBinding: async () =>
      ({
        granted: false,
      }) as unknown as Awaited<ReturnType<PluginCommandContext["requestConversationBinding"]>>,
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
    ...overrides,
  };
}

function seedPaymentProjection(outcome: "succeed" | "fail" = "succeed"): string {
  const clientAction: ClientAction = {
    kind: "interaction_projection",
    version: 1,
    projection: {
      id: "ip_test",
      domain: "commerce",
      presentation: { profile: "checkout.payment.confirm.v1", layout: "confirmation_card" },
      entity: { id: "pi_x" },
      actions: [{ id: "confirm_payment", label: "确认支付", operation_ref: "op_confirm" }],
      operations: {
        op_confirm: {
          kind: "mock_payment_gateway.confirm_intent.v1",
          params_schema: {
            type: "object",
            required: ["intent_id", "outcome"],
            additionalProperties: false,
            properties: {
              intent_id: { type: "string", minLength: 1 },
              outcome: { type: "string", enum: ["succeed", "fail"] },
            },
          },
          params: {
            intent_id: { $from: "entity.id" },
            outcome: { $const: outcome },
          },
        },
      },
      secrets: { client_secret: "sek_should_not_leak" },
    },
  };
  const block = buildInteractionButtons([clientAction]);
  expect(block).not.toBeNull();
  return block!.buttons[0].value.replace(/^\/chromite-pay\s+/, "");
}

beforeEach(() => {
  clearPendingPayOperations();
});

describe("createPayCommand", () => {
  it("confirms a buyer payment intent through mock-gateway using an opaque token", async () => {
    const token = seedPaymentProjection("succeed");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const cmd = createPayCommand({
      pluginConfig: { mockGatewayUrl: "http://mock-gw" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = (await cmd.handler(makeCtx({ args: token }))) as PluginCommandResult;

    expect(result.text).toContain("支付已确认");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://mock-gw/v1/payment_intents/pi_x/confirm");
    expect(url).not.toContain("manual-confirm");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ outcome: "succeed" });
    expect(token).not.toContain("pi_x");
    expect(token).not.toContain("succeed");
  });

  it("can simulate payment failure without leaking client_secret", async () => {
    const token = seedPaymentProjection("fail");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const cmd = createPayCommand({
      pluginConfig: { mockGatewayUrl: "http://mock-gw" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = (await cmd.handler(makeCtx({ args: token }))) as PluginCommandResult;

    expect(result.text).toContain("已模拟支付失败");
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.stringify(init)).not.toContain("client_secret");
    expect(JSON.stringify(init)).not.toContain("sek_should_not_leak");
    expect(JSON.parse(String(init.body))).toEqual({ outcome: "fail" });
  });

  it("returns usage for malformed button command tokens", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const cmd = createPayCommand({
      pluginConfig: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = (await cmd.handler(makeCtx({ args: "token extra" }))) as PluginCommandResult;

    expect(result.text).toContain("用法");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports unknown or expired operation tokens", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const cmd = createPayCommand({
      pluginConfig: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = (await cmd.handler(makeCtx({ args: "op_missing" }))) as PluginCommandResult;

    expect(result.text).toContain("payment operation token not found");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports non-2xx mock-gateway responses", async () => {
    const token = seedPaymentProjection("succeed");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const cmd = createPayCommand({
      pluginConfig: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = (await cmd.handler(makeCtx({ args: token }))) as PluginCommandResult;

    expect(result.text).toContain("HTTP 404");
  });
});

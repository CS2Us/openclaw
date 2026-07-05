// `/chromite-pay` command — buyer-side interaction projection callback path.
//
// Projection buttons carry only an opaque local token. The resolved operation
// params live in projection-engine's pending store and are validated before the
// command calls mock-payment-gateway.

import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  resolveChromiteUrl,
  resolveInteractionRuntimeMode,
  resolveMockGatewayUrl,
  resolveRequestTimeoutMs,
  type ChromiteBridgeConfig,
} from "./config.js";
import { executePayOperation, parsePayConfirm } from "./projection-engine.js";

export function createPayCommand(options: {
  pluginConfig?: unknown;
  fetchImpl?: typeof fetch;
}): OpenClawPluginCommandDefinition {
  return {
    name: "chromite-pay",
    description: "Buyer-side payment projection callback. Usage: /chromite-pay <operation-token>",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handlePayCommand(ctx, options),
  };
}

async function handlePayCommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown; fetchImpl?: typeof fetch },
): Promise<PluginCommandResult> {
  const cfg = (options.pluginConfig ?? {}) as ChromiteBridgeConfig;
  const raw = `/chromite-pay ${(ctx.args ?? "").trim()}`.trim();
  const parsed = parsePayConfirm(raw);
  if (!parsed) {
    return { text: "用法：/chromite-pay <operation-token>" };
  }

  const timeoutMs = resolveRequestTimeoutMs(cfg);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetchImpl: typeof fetch = async (url, init) =>
    await (options.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal });

  try {
    // Redeem bound to the caller principal — the pending token only executes for
    // the same (accountId, senderId) it was minted for (projection-engine).
    const caller = { accountId: ctx.accountId, senderId: ctx.senderId ?? "" };
    if (resolveInteractionRuntimeMode(cfg) === "chromite-b1") {
      const result = await redeemChromiteOperation(
        parsed.token,
        resolveChromiteUrl(cfg),
        ctx.channel ?? "telegram",
        caller.senderId,
        fetchImpl,
      );
      if (result.status === "redeemed") {
        const states = [
          result.paymentState ? `Payment=${result.paymentState}` : undefined,
          result.orderState ? `Order=${result.orderState}` : undefined,
        ]
          .filter(Boolean)
          .join(" / ");
        return {
          text: `✅ 支付操作已提交${states ? `（${states}）` : ""}。`,
        };
      }
      return { text: `❌ 支付操作不可用：${result.message}` };
    }

    const result = await executePayOperation(
      parsed.token,
      resolveMockGatewayUrl(cfg),
      caller,
      fetchImpl,
    );
    if (result.ok) {
      return {
        text:
          result.outcome === "succeed"
            ? "✅ 支付已确认，稍后订单会通过 webhook/outbox 更新。"
            : "✅ 已模拟支付失败。",
      };
    }
    return { text: `❌ 支付确认失败（HTTP ${result.status}）` };
  } catch (err) {
    const message = controller.signal.aborted
      ? `mock-gateway request timed out after ${timeoutMs} ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return { text: `❌ 支付确认调用失败：${message}` };
  } finally {
    clearTimeout(timer);
  }
}

type ChromiteRedeemResult = {
  status: "redeemed" | "unavailable" | "rejected";
  message: string;
  paymentState?: string;
  orderState?: string;
};

async function redeemChromiteOperation(
  token: string,
  chromiteUrl: string,
  channel: string,
  senderId: string,
  fetchImpl: typeof fetch,
): Promise<ChromiteRedeemResult> {
  const base = chromiteUrl.replace(/\/+$/, "");
  const resp = await fetchImpl(`${base}/v1/interaction/operations/redeem`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-channel": channel,
      "x-session-token": senderId,
    },
    body: JSON.stringify({
      kind: "interaction_operation_redeem",
      version: 1,
      token,
    }),
  });
  const body = await readJsonRecord(resp);
  if (!resp.ok) {
    const message = readString(body.message) ?? readString(body.error) ?? `HTTP ${resp.status}`;
    throw new Error(message);
  }
  const result = isRecord(body.result) ? body.result : {};
  const status = readString(result.status);
  if (status !== "redeemed" && status !== "unavailable" && status !== "rejected") {
    throw new Error("chromite redeem response is invalid");
  }
  return {
    status,
    message: readString(result.message) ?? "operation result missing message",
    paymentState: readString(result.payment_state) ?? undefined,
    orderState: readString(result.order_state) ?? undefined,
  };
}

async function readJsonRecord(resp: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await resp.json()) as unknown;
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

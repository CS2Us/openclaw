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

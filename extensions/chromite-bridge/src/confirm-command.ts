// `/confirm` command — seller manual confirm path.
// spec docs/specs/2026-05-16-chromite-commerce-payment-manual-confirm-v1.md 决策 #A / #D.
//
// Flow:
//   seller DMs `@bot /confirm <order-id> <payment-id>`
//   → senderId checked against sellerTelegramUserIds whitelist
//   → POST chromite /v1/commerce/manual-confirm
//   → reply with payment / order state
//
// Bypasses the LLM agent loop — flipping Payment state is a seller admin
// action, not something the agent should be empowered to do.

import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  isSellerTelegramUser,
  resolveChromiteUrl,
  resolveRequestTimeoutMs,
  type ChromiteBridgeConfig,
} from "./config.js";

type ManualConfirmResponse = {
  payment_state?: string;
  order_state?: string;
  already_confirmed?: boolean;
  dispatch_errors?: string[];
  error?: string;
  message?: string;
};

export function createConfirmCommand(options: {
  pluginConfig?: unknown;
  fetchImpl?: typeof fetch;
}): OpenClawPluginCommandDefinition {
  return {
    name: "confirm",
    description:
      "Seller-only: confirm manual payment for an order. Usage: /confirm <order-id> <payment-id>",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleConfirmCommand(ctx, options),
  };
}

async function handleConfirmCommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown; fetchImpl?: typeof fetch },
): Promise<PluginCommandResult> {
  const cfg = (options.pluginConfig ?? {}) as ChromiteBridgeConfig;

  // Seller whitelist check — v1 single-seller (you).
  if (!isSellerTelegramUser(cfg, ctx.senderId)) {
    return {
      reply: "你不是登记的卖家，无权使用 /confirm 命令。",
    };
  }

  const args = (ctx.args ?? "").trim();
  const parts = args.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length < 2) {
    return {
      reply:
        "用法：/confirm <order-id> <payment-id>\n（两个 ID 都需要——买家完成 commerce_pay 时会同时返回。）",
    };
  }
  const [orderId, paymentId] = parts;

  const url = `${resolveChromiteUrl(cfg)}/v1/commerce/manual-confirm`;
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = resolveRequestTimeoutMs(cfg);

  const abortCtl = new AbortController();
  const timer = setTimeout(() => abortCtl.abort(), timeoutMs);
  try {
    const resp = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: orderId,
        payment_id: paymentId,
        seller_id: ctx.senderId ?? null,
      }),
      signal: abortCtl.signal,
    });

    const text = await resp.text();
    let parsed: ManualConfirmResponse;
    try {
      parsed = text ? (JSON.parse(text) as ManualConfirmResponse) : {};
    } catch {
      return {
        reply: `chromite 返回非 JSON 响应（HTTP ${resp.status}）：${text.slice(0, 200)}`,
      };
    }

    if (resp.ok) {
      const already = parsed.already_confirmed ? "（重复调用：之前已确认）" : "";
      return {
        reply:
          `✅ Order ${orderId} / Payment ${paymentId}\n` +
          `Payment=${parsed.payment_state ?? "?"} / Order=${parsed.order_state ?? "?"}${already}`,
      };
    }

    const errKind = parsed.error ?? "Unknown";
    const errMsg = parsed.message ?? text.slice(0, 200);
    return {
      reply: `❌ /confirm 失败 (HTTP ${resp.status} / ${errKind}): ${errMsg}`,
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { reply: `❌ /confirm 调用 chromite 失败：${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

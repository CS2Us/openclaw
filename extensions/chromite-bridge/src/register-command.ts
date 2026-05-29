// `/register` command — onboard a telegram user as a chromite buyer.
// spec docs/specs/2026-05-17-chromite-identity-register-command-v1.md 决策 #E / #G.
//
// Flow:
//   user DMs `@bot /register <昵称>`
//   → senderId (telegram user_id) extracted
//   → POST chromite /v1/identity/register
//   → reply with chromite user_id receipt (created vs already-registered)
//
// Unlike /confirm, no seller whitelist — any chat-level allowFrom user can register.
// chromite-side validation (display_name length, channel known) provides the safety net.

import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  resolveChromiteUrl,
  resolveRequestTimeoutMs,
  type ChromiteBridgeConfig,
} from "./config.js";

const TELEGRAM_CHANNEL = "telegram";

type RegisterResponse = {
  user_id?: string;
  display_name?: string;
  created?: boolean;
  error?: string;
  message?: string;
};

export function createRegisterCommand(options: {
  pluginConfig?: unknown;
  fetchImpl?: typeof fetch;
}): OpenClawPluginCommandDefinition {
  return {
    name: "register",
    description: "Register as a chromite buyer. Usage: /register <昵称>",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleRegisterCommand(ctx, options),
  };
}

async function handleRegisterCommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown; fetchImpl?: typeof fetch },
): Promise<PluginCommandResult> {
  const cfg = (options.pluginConfig ?? {}) as ChromiteBridgeConfig;

  if (!ctx.senderId) {
    return {
      text: "❌ /register 无法识别你的 telegram 身份 (no senderId)。请联系管理员。",
    };
  }

  const displayName = (ctx.args ?? "").trim();
  if (!displayName) {
    return {
      text: "用法：/register <昵称>\n例：/register 张三",
    };
  }

  const url = `${resolveChromiteUrl(cfg)}/v1/identity/register`;
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = resolveRequestTimeoutMs(cfg);

  const abortCtl = new AbortController();
  const timer = setTimeout(() => abortCtl.abort(), timeoutMs);
  try {
    const resp = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: TELEGRAM_CHANNEL,
        channel_user_id: ctx.senderId,
        display_name: displayName,
      }),
      signal: abortCtl.signal,
    });

    const text = await resp.text();
    let parsed: RegisterResponse;
    try {
      parsed = text ? (JSON.parse(text) as RegisterResponse) : {};
    } catch {
      return {
        text: `❌ chromite 返回非 JSON 响应 (HTTP ${resp.status}): ${text.slice(0, 200)}`,
      };
    }

    if (resp.ok && parsed.user_id) {
      if (parsed.created) {
        return {
          text:
            `✅ 注册成功\n` +
            `昵称：${parsed.display_name ?? displayName}\n` +
            `chromite user_id：${parsed.user_id}`,
        };
      }
      return {
        text:
          `ℹ️ 你已经注册过了\n` +
          `昵称：${parsed.display_name ?? "(未知)"}\n` +
          `chromite user_id：${parsed.user_id}\n` +
          `（想改昵称请等 /rename 命令上线）`,
      };
    }

    // 4xx / 5xx
    const errKind = parsed.error ?? "Unknown";
    const errMsg = parsed.message ?? text.slice(0, 200);
    if (resp.status >= 400 && resp.status < 500) {
      return {
        text: `❌ /register 输入有问题：${errMsg}\n（${errKind}）`,
      };
    }
    return {
      text: `❌ /register 暂时不可用（HTTP ${resp.status} / ${errKind}），稍后再试。`,
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { text: `❌ /register 调用 chromite 失败：${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

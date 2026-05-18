// chromite-bridge inbound_claim hook —— 抢在内嵌 agent dispatch 之前 claim 消息。
//
// **背景**：openclaw 默认 inbound DM 会走 embedded agent (model.default, 例如
// openai/gpt-5.5)。registerInboundFallthroughHandler 已注册但**优先级低于**
// embedded agent —— 后者在 commands/agent dispatch 阶段就跑了，fallthrough
// 只在更后面，所以 DM 实际从未被 fallthrough 兜到 chromite-server。
//
// **修复**：用 `inbound_claim` hook (openclaw 文档原话：*"Allows plugins to claim
// an inbound event before commands/agent dispatch."*)。该 hook 是 claiming
// pattern —— 第一个返回 handled=true 的 plugin 停止后续 hook + 跳过 embedded
// agent dispatch。
//
// **范围**：仅 Telegram channel + 非命令（`/chromite` / `/confirm` / `/register`
// 仍走 registerCommand 注册的命令路径）。

import type {
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
  PluginHookInboundClaimResult,
} from "openclaw/plugin-sdk/plugin-runtime";
import { dispatchChromiteRound } from "./handler.js";

export type ChromiteBridgeInboundClaimOptions = {
  pluginConfig?: unknown;
  /** Test seam —— allow swapping dispatcher for unit tests. */
  dispatcher?: typeof dispatchChromiteRound;
};

export function createChromiteBridgeInboundClaimHandler(
  options: ChromiteBridgeInboundClaimOptions = {},
): (
  event: PluginHookInboundClaimEvent,
  ctx: PluginHookInboundClaimContext,
) => Promise<PluginHookInboundClaimResult | undefined> {
  const dispatcher = options.dispatcher ?? dispatchChromiteRound;
  return async (event, _ctx) => {
    // 只接 telegram channel；其它 channel 不 claim
    if (event.channel !== "telegram") {
      return undefined;
    }
    // 群聊 v1 不接（chromite-bridge 设计是 1-on-1 DM；resolution-middleware-v1 §2 #D 同样假设）
    if (event.isGroup) {
      return undefined;
    }
    // `/chromite` / `/confirm` / `/register` 走 registerCommand 注册的命令路径，
    // 不 claim 让命令系统接管。
    if (event.commandAuthorized === true) {
      return undefined;
    }
    // 取消息文本：优先 bodyForAgent（host 已做 mention strip / 格式化），否则 content
    const text = (event.bodyForAgent ?? event.content ?? "").trim();
    if (!text) {
      return undefined;
    }
    // chatId / senderId: 1-on-1 DM 下 conversationId == sender_id == chat_id；
    // fallthrough handler 同样依赖此假设（fallthrough.ts comment 引 resolution-middleware-v1 §2 #D）
    const chatId = event.conversationId ?? event.senderId ?? "";
    if (!chatId) {
      return undefined;
    }
    try {
      const result = await dispatcher({
        chatId,
        accountId: event.accountId,
        text,
        senderId: event.senderId ?? chatId,
        pluginConfig: options.pluginConfig,
      });
      return { handled: true, reply: { text: result.reply } };
    } catch (err) {
      // claim 后失败：给用户一个 fallback reply 而不是悄悄丢消息（embedded agent
      // 在 commandAuthorized=false 时已被本 hook claim 排除，没有 fallback 路径）
      const msg = err instanceof Error ? err.message : String(err);
      return {
        handled: true,
        reply: { text: `chromite-bridge: dispatch failed — ${msg}` },
      };
    }
  };
}

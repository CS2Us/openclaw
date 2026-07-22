// Tab-manager interactive handler. Receives Telegram inline-keyboard taps,
// mutates ChatState, and re-renders the manager UI in place via
// `respond.editMessage` for direct, single-tap interaction.
//
// We use the generic `PluginInteractiveHandlerRegistration` from the plugin
// SDK and locally mirror the Telegram-specific context shape — the
// `extensions/telegram/api.ts` barrel cannot be imported from another
// extension per the bundled-extension boundary rules. The structural mirror
// is fine because TS is structural; if the channel ever broadens the context
// shape, our local type just gets stale and the handler keeps compiling.

import path from "node:path";
import type { PluginInteractiveHandlerRegistration } from "openclaw/plugin-sdk/plugin-runtime";
import {
  chatStateKey,
  closeTab,
  createNewTab,
  getActiveFollow,
  getActiveTab,
  getOrCreateChatState,
  importSessionAsTab,
  resetChatState,
  stopActiveFollow,
} from "./chat-state.js";
import { getDaemonGatewayClient } from "./daemon-gateway-client.js";
import { normalizeTelegramChatId, notifyFollowEvent, startAndRegisterFollow } from "./follow.js";
import { type AgentBridgeConfig, resolveProjectCwd } from "./handler.js";
import { deliverPanel } from "./panel-delivery.js";
import { setPanelId } from "./panel-id-store.js";
import {
  listSessionFiles,
  readLastTurn,
  readSessionInfo,
  sessionsDir,
} from "./session-discovery.js";
import {
  INTERACTIVE_NAMESPACE,
  type PanelEntry,
  parseCallbackPayload,
  renderPanel,
} from "./tab-manager-ui.js";
import { resolveFollowTarget } from "./topic-routing.js";

type TelegramInteractiveCtx = {
  channel: "telegram";
  callback: {
    payload: string;
    chatId: string;
    /**
     * Telegram message_id of the message that holds the tapped button. For
     * panel buttons this is the panel message; for approval-card buttons
     * (e.g. enterAndFollow) this is the approval card. We use this to keep
     * the persistent panel-id store in sync with reality — the *displayed*
     * panel is authoritative, not whatever was last persisted.
     *
     * Structurally mirrored from the telegram extension's callback context
     * (see extensions/telegram/src/interactive-dispatch.ts).
     */
    messageId?: number;
  };
  auth: { isAuthorizedSender: boolean };
  // No `respond` mirror anymore: the panel pipeline writes via
  // panel-delivery.ts (raw editMessageText), and runtime auto-acks the
  // callback after the handler returns, so t.respond.editMessage isn't
  // needed just to clear the button loading icon.
};

export function createTabManagerInteractiveHandler(options?: {
  pluginConfig?: unknown;
}): PluginInteractiveHandlerRegistration {
  const config = (options?.pluginConfig ?? {}) as AgentBridgeConfig;
  return {
    channel: "telegram",
    namespace: INTERACTIVE_NAMESPACE,
    handler: async (ctx) => {
      const t = ctx as TelegramInteractiveCtx;
      // Telegram extension already screens inbound traffic against
      // `allowFrom`; this is a paranoid second check on the async callback
      // path, where dispatch races could in principle land from elsewhere.
      if (!t.auth.isAuthorizedSender) {
        return { handled: true };
      }

      const key = chatStateKey("telegram", t.callback.chatId);
      const parsed = parseCallbackPayload(t.callback.payload);
      const cwd = resolveProjectCwd(config);
      const tgToken = process.env.TG_BOT_TOKEN ?? "";
      const tgChatId = normalizeTelegramChatId(t.callback.chatId);
      let header: string | undefined;

      // Sync the persistent panel id with reality. Most callback kinds
      // originate from a button on the panel itself, so the message id we
      // got from the callback IS the panel — adopt it as the canonical id
      // so subsequent edits (this turn or future /agent turns) hit the
      // right message. Two exceptions are skipped because their button
      // lives elsewhere:
      //   - enterAndFollow: comes from the approval card; the panel still
      //     lives at the previously-persisted id (or no id yet).
      //   - approveDecision: comes from the approval card; doesn't touch
      //     panel rendering at all (early return below).
      const fromPanel = parsed.kind !== "enterAndFollow" && parsed.kind !== "approveDecision";
      if (fromPanel && typeof t.callback.messageId === "number") {
        setPanelId(key, {
          chatId: tgChatId,
          messageId: t.callback.messageId,
          updatedAt: Date.now(),
        });
      }

      switch (parsed.kind) {
        case "switch":
          // 切换会话隐式取消旧 follow（旧 stream 跟当前 session 不一致了）
          stopActiveFollow(key);
          importSessionAsTab(key, parsed.sessionId);
          header = cwd
            ? buildSwitchHeader(cwd, parsed.sessionId)
            : `📍 切到 session \`${parsed.sessionId.slice(0, 8)}\``;
          break;
        case "newTab":
          stopActiveFollow(key);
          createNewTab(key);
          header = "📍 已起新 session（往下打字开始对话）";
          break;
        case "follow": {
          const active = getActiveTab(getOrCreateChatState(key));
          if (!active?.sessionId || !cwd) {
            header = "⚠️ 没有选中的 session 或 cwd 解析失败，无法 follow";
            break;
          }
          const target = await resolveFollowTarget({
            dmChatId: tgChatId,
            cwd,
            sessionId: active.sessionId,
            botToken: tgToken,
          });
          const handle = startAndRegisterFollow({
            chatKey: key,
            sessionId: active.sessionId,
            cwd,
            telegramChatId: target.chatId,
            telegramBotToken: tgToken,
            telegramThreadId: target.messageThreadId,
          });
          if (handle) {
            await notifyFollowEvent(
              tgToken,
              target.chatId,
              `📡 开始 follow session \`${active.sessionId.slice(0, 8)}\`（30 分钟上限，期间该 session 新事件实时推过来）`,
              target.messageThreadId,
            );
            header =
              target.messageThreadId !== undefined
                ? `📡 follow 中（forum topic · 输出推到独立线程）`
                : "📡 follow 中";
          } else {
            header = "⚠️ follow 启动失败（jsonl 不存在？）";
          }
          // 同一个面板原地变成 [⏹ 停止流]，不发新面板，避免 chat 历史里
          // 同时存在两个 panel 让人不知道哪个是当前
          break;
        }
        case "enterAndFollow": {
          // Originates from the perm-hook approval-companion message: one-tap
          // "step into this session + start streaming + show the last turn so
          // I understand what claude was doing when the approval fired".
          // Standard openclaw approval card with allow/deny lands as a
          // separate message right after.
          if (!cwd) {
            header = "⚠️ cwd 解析失败，无法进入 session";
            break;
          }
          stopActiveFollow(key);
          importSessionAsTab(key, parsed.sessionId);
          header = buildSwitchHeader(cwd, parsed.sessionId);
          const target = await resolveFollowTarget({
            dmChatId: tgChatId,
            cwd,
            sessionId: parsed.sessionId,
            botToken: tgToken,
          });
          const handle = startAndRegisterFollow({
            chatKey: key,
            sessionId: parsed.sessionId,
            cwd,
            telegramChatId: target.chatId,
            telegramBotToken: tgToken,
            telegramThreadId: target.messageThreadId,
          });
          if (handle) {
            await notifyFollowEvent(
              tgToken,
              target.chatId,
              `📡 follow 中 · session \`${parsed.sessionId.slice(0, 8)}\` —— 等 perm-hook 抬手发卡片`,
              target.messageThreadId,
            );
          }
          // enterAndFollow 来自 approval 通知卡片：panel 的真身在别处（上一次
          // /agent 发的位置），由 panel-delivery 拿持久化 id 原地刷新它，approval
          // 卡片保留原状。
          break;
        }
        case "unfollow": {
          const stopped = stopActiveFollow(key);
          if (stopped) {
            await notifyFollowEvent(
              tgToken,
              tgChatId,
              `⏹ 已停止 follow（sid=\`${stopped.sessionId.slice(0, 8)}\`）`,
            );
            header = "⏹ follow 已停";
          } else {
            header = "ℹ️ 当前没有 follow 在跑";
          }
          // 与 follow 对称：在同一面板上把按钮换回 [👁 实时流]
          break;
        }
        case "approveDecision": {
          // Our own approval card from perm-hook.cjs. Resolve the openclaw
          // approval state directly via a loopback WS client — no file IPC,
          // no perm-hook polling. perm-hook's `plugin.approval.waitDecision`
          // returns instantly when the gateway emits the resolved event,
          // saving ~150-300ms vs the old file-poll path.
          //
          // Fire-and-forget: we don't await because the user's click ack
          // shouldn't block on the resolve round-trip. If the resolve fails,
          // perm-hook eventually hits its 110s server-side timeout and emits
          // deny to claude (safe fallback).
          const client = getDaemonGatewayClient();
          if (client) {
            void client.resolveApproval(parsed.approvalId, parsed.decision).catch((err) => {
              process.stderr.write(`[agent-bridge] resolveApproval failed: ${String(err)}\n`);
            });
          } else {
            process.stderr.write(
              "[agent-bridge] daemon gateway client unavailable (no OPENCLAW_GATEWAY_PASSWORD?); approval will time out\n",
            );
          }
          // No reply or panel re-render: perm-hook will edit the original
          // approval card to show the resolution once waitDecision returns.
          return { handled: true };
        }
        // 以下三个 legacy action 仍解析但只 silently refresh，
        // chat 历史中的旧 button 不会报错
        case "closeTab":
          closeTab(key, parsed.tabId);
          break;
        case "resetAll":
          resetChatState(key);
          break;
        case "import":
          importSessionAsTab(key, parsed.sessionId);
          break;
        case "refresh":
        case "unknown":
          break;
      }

      // 读 pool 当前 top 3 重新渲染面板（跟 command.ts 共享筛选逻辑：
      // 跳过 arbitrator / 空 preview 的污染 session）
      const state = getOrCreateChatState(key);
      const entries: PanelEntry[] = [];
      if (cwd) {
        const files = listSessionFiles(cwd);
        for (const f of files) {
          // Same +1 over MAX_PANEL_ENTRIES as command.ts: renderPanel drops
          // the active session from the switch list, so we need a spare to
          // still fill 3 *other* slots.
          if (entries.length >= 4) break;
          const info = readSessionInfo(f.jsonlPath);
          if (info.preview && info.preview.startsWith("判断以下 tool call")) continue;
          if (!info.preview) continue;
          entries.push({
            sessionId: f.sessionId,
            preview: info.preview,
            lastActivityMs: info.lastEventMs ?? f.mtimeMs,
          });
        }
      }
      const activeSessionId = getActiveTab(state)?.sessionId ?? null;
      const followActive = getActiveFollow(key) !== undefined;
      const refreshed = renderPanel({ entries, activeSessionId, header, followActive });

      // Single-panel pipeline: edit the persisted panel message in place.
      // For enterAndFollow, the persisted id points to the prior /agent
      // panel (the approval card is left untouched). For other cases, we
      // updated the persisted id above to match the callback's source
      // message, so the edit lands on the very button the user just
      // tapped. Runtime auto-acks the callback after we return.
      await deliverPanel({
        chatKey: key,
        chatId: tgChatId,
        botToken: tgToken,
        text: refreshed.text,
        blocks: refreshed.interactive.blocks,
      });

      return { handled: true };
    },
  };
}

/**
 * Build the rich header shown above the panel after a /agent session switch.
 * Surfaces: session title (your first prompt), age + event count, and the
 * "last turn" snippet (your most recent question + claude's most recent reply
 * to that session). Lets the user see what context they're stepping into
 * instead of just a hash.
 */
function buildSwitchHeader(cwd: string, sessionId: string): string {
  const jsonlPath = path.join(sessionsDir(cwd), `${sessionId}.jsonl`);
  const info = readSessionInfo(jsonlPath);
  const turn = readLastTurn(jsonlPath);

  const lines: string[] = [];
  const title = info.preview ?? sessionId.slice(0, 8);
  lines.push(`📍 切到 session: ${title}`);

  if (info.lastEventMs != null) {
    const ageText = formatAge(info.lastEventMs);
    lines.push(`📅 ${ageText} · ${info.eventCount} 条事件 · sid=\`${sessionId.slice(0, 8)}\``);
  }

  if (turn.lastUserText || turn.lastAssistantText) {
    lines.push("");
    lines.push("最近一段：");
    if (turn.lastUserText) {
      lines.push(`> 你：${truncate(turn.lastUserText, 150)}`);
    }
    if (turn.lastAssistantText) {
      lines.push(`> claude：${truncate(turn.lastAssistantText, 250)}`);
    }
  }

  return lines.join("\n");
}

function formatAge(ms: number, nowMs: number = Date.now()): string {
  const diffMin = Math.max(0, Math.round((nowMs - ms) / 60_000));
  if (diffMin < 1) return "刚才";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay} 天前`;
}

function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

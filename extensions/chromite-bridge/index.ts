import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { setChromiteBridgeRuntime } from "./src/chat-state-store.js";
import { hydrateChatStatesFromStore } from "./src/chat-state.js";
import { fetchRelayTicket } from "./src/chromite-client.js";
import { createChromiteCommand } from "./src/command.js";
import {
  resolveChromiteUrl,
  resolveRelayPushEnabled,
  resolveRelayUrl,
  type ChromiteBridgeConfig,
} from "./src/config.js";
import { createConfirmCommand } from "./src/confirm-command.js";
import { createChromiteBridgeFallthroughHandler } from "./src/fallthrough.js";
import { createChromiteBridgeInboundClaimHandler } from "./src/inbound-claim.js";
import { createPayCommand } from "./src/pay-command.js";
import { createRegisterCommand } from "./src/register-command.js";
import {
  deletePendingSubscription,
  loadAllPendingSubscriptions,
  persistPendingSubscription,
  setRelayPushStoreRuntime,
} from "./src/relay-push-store.js";
import { initRelayPush, RelayPushService } from "./src/relay-push.js";

export default definePluginEntry({
  id: "chromite-bridge",
  name: "Chromite Bridge",
  description:
    "Drive a client-side AI-commerce agent loop against local chromite-server (gateway + zero-trust commerce RPCs) for Telegram DMs and /chromite commands.",
  register(api) {
    setChromiteBridgeRuntime(api.runtime);
    setRelayPushStoreRuntime(api.runtime);
    // Hydrate persisted per-chat session_ids so first DM after daemon restart
    // reuses the same chromite session. Fire-and-forget: in-memory chat-state
    // remains correct (empty) until this resolves, and the keyed-store layer
    // is best-effort.
    void hydrateChatStatesFromStore().catch(() => {
      // chat-state-store already logs the underlying failure and disables
      // itself; nothing to do here.
    });

    // Relay push consumer (spec chromite-relay-push-consumer-v1): subscribe
    // buyer conv topics on the relay and forward SystemNotification pushes
    // into telegram chats. Lazy socket — nothing connects until a payment
    // card renders (or persisted pending subscriptions are restored below).
    const bridgeConfig = (api.pluginConfig ?? {}) as ChromiteBridgeConfig;
    if (resolveRelayPushEnabled(bridgeConfig)) {
      const logger = api.runtime.logging.getChildLogger({
        plugin: "chromite-bridge",
        feature: "relay-push",
      });
      const chromiteUrl = resolveChromiteUrl(bridgeConfig);
      const service = new RelayPushService({
        url: resolveRelayUrl(bridgeConfig),
        // chromite-relay-session-auth-v1: fetch a per-conv 60s join ticket using
        // the buyer's telegram id as the zero-trust session token. Returns null
        // (→ ensure-joined retry) on any failure; never throws.
        fetchTicket: (sub) =>
          sub.senderId
            ? fetchRelayTicket({ chromiteUrl, orderId: sub.orderId, senderId: sub.senderId })
            : Promise.resolve(null),
        deliver: async ({ chatId, accountId, text }) => {
          // Lazy import: outbound delivery is a heavy core surface; only load
          // it when a push actually needs to reach telegram.
          const [{ deliverOutboundPayloads }, { getRuntimeConfig }] = await Promise.all([
            import("openclaw/plugin-sdk/outbound-runtime"),
            import("openclaw/plugin-sdk/config-runtime"),
          ]);
          await deliverOutboundPayloads({
            cfg: await getRuntimeConfig(),
            channel: "telegram",
            to: chatId,
            accountId,
            payloads: [{ text }],
          });
        },
        persist: { save: persistPendingSubscription, remove: deletePendingSubscription },
        log: (level, msg, data) => {
          try {
            logger[level](msg, data);
          } catch {
            // logging best-effort
          }
        },
      });
      initRelayPush(service);
      void loadAllPendingSubscriptions()
        .then((subs) => service.restoreSubscriptions(subs))
        .catch(() => {
          // relay-push-store already logs and disables itself.
        });
    }

    api.registerCommand(createChromiteCommand({ pluginConfig: api.pluginConfig }));
    api.registerCommand(createConfirmCommand({ pluginConfig: api.pluginConfig }));
    api.registerCommand(createPayCommand({ pluginConfig: api.pluginConfig }));
    api.registerCommand(createRegisterCommand({ pluginConfig: api.pluginConfig }));
    // inbound_claim runs BEFORE commands/agent dispatch — needed to preempt the
    // embedded auto-reply agent for plain telegram DMs. registerInboundFallthrough
    // (below) runs LATER in the bot pipeline so the embedded agent fires first
    // unless something claims here.
    api.on(
      "inbound_claim",
      createChromiteBridgeInboundClaimHandler({ pluginConfig: api.pluginConfig }),
    );
    // Kept for back-compat / fallback if another plugin claims first but does
    // not actually handle a telegram DM body.
    api.registerInboundFallthroughHandler({
      channel: "telegram",
      handler: createChromiteBridgeFallthroughHandler({
        pluginConfig: api.pluginConfig,
      }),
    });
  },
});

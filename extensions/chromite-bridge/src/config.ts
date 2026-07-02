// Plugin config schema (parsed from openclaw.plugin.json's configSchema by SDK).
// sub-spec chromite-harness-openclaw-bridge-v1 §3 决策 #E.

export type ChromiteBridgeConfig = {
  chromiteUrl?: string;
  maxReplyChars?: number;
  requestTimeoutMs?: number;
  /**
   * @deprecated rbac-v1 (spec docs/specs/2026-05-29-chromite-identity-rbac-v1.md):
   * seller 鉴权已下沉到 chromite (users.role='seller')。此白名单不再被 `/confirm` 消费，
   * 保留仅为配置向后兼容，可安全移除。原 v1 设计见
   * docs/specs/2026-05-16-chromite-commerce-payment-manual-confirm-v1.md 决策 #D。
   */
  sellerTelegramUserIds?: string[];
  /**
   * OPT-IN durable edge-loop resilience (chromite sub-spec ④ R1). When set, the
   * native loop persists per-session pending snapshots here and restores an
   * interrupted loop on a later call with the same session_id. Absent → the
   * existing non-resumable behavior (no cross-call durability).
   *
   * ⚠️ Activation gate: restore re-sends the gateway turn and can re-dispatch a
   * non-idempotent commerce tool (double charge). Only enable once backend
   * commerce idempotency is in place. Env override: `CHROMITE_PENDING_STORE_DIR`.
   */
  pendingStoreDir?: string;
  /**
   * mock 支付网关 base URL（interaction-projection-v1 / checkout payment operation）。买家点支付
   * 按钮后，callback 打 `{mockGatewayUrl}/v1/payment_intents/{id}/confirm`（MP-5：**禁**走
   * chromite manual-confirm）。env override: `CHROMITE_MOCK_GATEWAY_URL`。缺省对齐 mock-gateway bin。
   */
  mockGatewayUrl?: string;
};

const DEFAULT_URL = "http://127.0.0.1:8080";
const DEFAULT_MAX_REPLY_CHARS = 3500;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MOCK_GATEWAY_URL = "http://127.0.0.1:8090";

export function resolveChromiteUrl(config: ChromiteBridgeConfig): string {
  const envUrl = process.env.CHROMITE_BRIDGE_URL;
  if (envUrl && envUrl.trim()) {
    return envUrl.trim().replace(/\/+$/, "");
  }
  const fromConfig = config.chromiteUrl?.trim();
  if (fromConfig) {
    return fromConfig.replace(/\/+$/, "");
  }
  return DEFAULT_URL;
}

export function resolveMockGatewayUrl(config: ChromiteBridgeConfig): string {
  const envUrl = process.env.CHROMITE_MOCK_GATEWAY_URL;
  if (envUrl && envUrl.trim()) {
    return envUrl.trim().replace(/\/+$/, "");
  }
  const fromConfig = config.mockGatewayUrl?.trim();
  if (fromConfig) {
    return fromConfig.replace(/\/+$/, "");
  }
  return DEFAULT_MOCK_GATEWAY_URL;
}

export function resolveMaxReplyChars(config: ChromiteBridgeConfig): number {
  const v = config.maxReplyChars;
  return typeof v === "number" && v > 0 ? v : DEFAULT_MAX_REPLY_CHARS;
}

export function resolveRequestTimeoutMs(config: ChromiteBridgeConfig): number {
  const v = config.requestTimeoutMs;
  return typeof v === "number" && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

/**
 * Resolve the OPT-IN pending-store directory (chromite sub-spec ④ R1). Env
 * override (`CHROMITE_PENDING_STORE_DIR`) wins, then plugin config; absent →
 * `undefined`, which keeps the loop on its non-resumable path (safe default).
 *
 * ⚠️ Setting this ENABLES interrupted-loop restore in production, which re-sends
 * the gateway turn and can re-dispatch a non-idempotent commerce tool (double
 * charge). Only set it once backend commerce idempotency is guaranteed.
 */
export function resolvePendingStoreDir(config: ChromiteBridgeConfig): string | undefined {
  const envDir = process.env.CHROMITE_PENDING_STORE_DIR;
  if (envDir && envDir.trim()) {
    return envDir.trim();
  }
  const fromConfig = config.pendingStoreDir?.trim();
  return fromConfig ? fromConfig : undefined;
}

/** @deprecated rbac-v1: seller 鉴权下沉到 chromite users.role；此 helper 不再被消费。 */
export function resolveSellerTelegramUserIds(config: ChromiteBridgeConfig): readonly string[] {
  const raw = config.sellerTelegramUserIds;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** @deprecated rbac-v1: seller 鉴权下沉到 chromite users.role；此 helper 不再被消费。 */
export function isSellerTelegramUser(
  config: ChromiteBridgeConfig,
  senderId: string | undefined,
): boolean {
  if (!senderId) return false;
  const list = resolveSellerTelegramUserIds(config);
  return list.includes(senderId);
}

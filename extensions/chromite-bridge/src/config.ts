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
};

const DEFAULT_URL = "http://127.0.0.1:8080";
const DEFAULT_MAX_REPLY_CHARS = 3500;
const DEFAULT_TIMEOUT_MS = 300_000;

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

export function resolveMaxReplyChars(config: ChromiteBridgeConfig): number {
  const v = config.maxReplyChars;
  return typeof v === "number" && v > 0 ? v : DEFAULT_MAX_REPLY_CHARS;
}

export function resolveRequestTimeoutMs(config: ChromiteBridgeConfig): number {
  const v = config.requestTimeoutMs;
  return typeof v === "number" && v > 0 ? v : DEFAULT_TIMEOUT_MS;
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

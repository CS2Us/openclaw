// Plugin config schema (parsed from openclaw.plugin.json's configSchema by SDK).
// sub-spec chromite-harness-openclaw-bridge-v1 §3 决策 #E.

export type ChromiteBridgeConfig = {
  chromiteUrl?: string;
  maxReplyChars?: number;
  requestTimeoutMs?: number;
  /**
   * Telegram user IDs allowed to issue the `/confirm` seller command.
   * v1: hardcoded list. See spec
   * docs/specs/2026-05-16-chromite-commerce-payment-manual-confirm-v1.md 决策 #D.
   * v2: replaced by chromite-side identity (OAuth / token).
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

export function resolveSellerTelegramUserIds(config: ChromiteBridgeConfig): readonly string[] {
  const raw = config.sellerTelegramUserIds;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export function isSellerTelegramUser(
  config: ChromiteBridgeConfig,
  senderId: string | undefined,
): boolean {
  if (!senderId) return false;
  const list = resolveSellerTelegramUserIds(config);
  return list.includes(senderId);
}

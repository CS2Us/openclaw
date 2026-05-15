// Plugin config schema (parsed from openclaw.plugin.json's configSchema by SDK).
// sub-spec chromite-harness-openclaw-bridge-v1 §3 决策 #E.

export type ChromiteBridgeConfig = {
  chromiteUrl?: string;
  maxReplyChars?: number;
  requestTimeoutMs?: number;
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

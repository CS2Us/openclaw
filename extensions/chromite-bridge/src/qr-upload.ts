// Seller payment QR upload (C-lite) — spec chromite-personal-qr-openclaw-wiring-v1.
//
// Flow:
//   seller sends a photo with caption `/chromite-qr` to the bot
//   → inbound_claim early branch (commands never receive media; the claim hook
//     event carries `metadata.mediaPath` / `mediaUrl` for host-downloaded media)
//   → read bytes (≤512KB pre-check) → base64 → POST chromite /v1/sellers/payment-qr
//     (seller_id = sender telegram id)
//   → chromite rbac decides (users.role == Seller; openclaw does NOT keep a
//     local allowlist — AR-I1, same as /confirm)
//
// The QR image bytes are never logged.

import { readFile } from "node:fs/promises";
import {
  resolveChromiteUrl,
  resolveRequestTimeoutMs,
  type ChromiteBridgeConfig,
} from "./config.js";

export const QR_UPLOAD_COMMAND = "/chromite-qr";

/** Client-side pre-check mirror of chromite's MAX_QR_IMAGE_BYTES (authority is chromite). */
export const QR_UPLOAD_MAX_BYTES = 512 * 1024;

export type QrUploadRequest = {
  mediaPath?: string;
  mediaUrl?: string;
};

type ClaimEventLike = {
  content?: string;
  body?: string;
  bodyForAgent?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Detect a `/chromite-qr` upload request on an inbound claim event.
 * Returns `null` when the caption does not match; returns `{}` (no media)
 * when the caption matches but no photo came along (caller replies usage).
 */
export function matchQrUploadRequest(event: ClaimEventLike): QrUploadRequest | null {
  const text = (event.bodyForAgent ?? event.body ?? event.content ?? "").trim();
  if (text !== QR_UPLOAD_COMMAND) {
    return null;
  }
  const metadata = event.metadata ?? {};
  const mediaPath = readNonEmptyString(metadata.mediaPath);
  const mediaUrl = readNonEmptyString(metadata.mediaUrl);
  return {
    ...(mediaPath ? { mediaPath } : {}),
    ...(mediaUrl ? { mediaUrl } : {}),
  };
}

export type QrUploadOptions = {
  senderId: string;
  request: QrUploadRequest;
  pluginConfig?: unknown;
  fetchImpl?: typeof fetch;
  readFileImpl?: (path: string) => Promise<Buffer>;
};

/** Run the upload and return the user-facing receipt text. Never throws. */
export async function handleQrUpload(options: QrUploadOptions): Promise<string> {
  const { request } = options;
  if (!request.mediaPath && !request.mediaUrl) {
    return `用法：把收款码**图片**和说明文字 ${QR_UPLOAD_COMMAND} 一起发送（发照片时在 caption 里填 ${QR_UPLOAD_COMMAND}）。`;
  }
  if (!options.senderId) {
    return "无法识别发送者身份，收款码未上传。";
  }

  let bytes: Buffer;
  try {
    bytes = await loadMediaBytes(request, options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `收款码图片读取失败（${msg}），请重新发送。`;
  }
  if (bytes.length > QR_UPLOAD_MAX_BYTES) {
    return "图片过大（上限 512KB），请压缩后重新发送。";
  }
  if (bytes.length === 0) {
    return "收款码图片为空，请重新发送。";
  }

  const cfg = (options.pluginConfig ?? {}) as ChromiteBridgeConfig;
  const base = resolveChromiteUrl(cfg).replace(/\/+$/, "");
  const timeoutMs = resolveRequestTimeoutMs(cfg);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(`${base}/v1/sellers/payment-qr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        seller_id: options.senderId,
        image_base64: bytes.toString("base64"),
      }),
      signal: controller.signal,
    });
    const body = (await resp.json().catch(() => ({}))) as {
      content_type?: string;
      error?: string;
      message?: string;
    };
    if (resp.ok) {
      return `✅ 收款码已更新（${body.content_type ?? "image"}）。买家结账时会看到这张收款码。`;
    }
    if (resp.status === 403) {
      // chromite rbac already returns user-facing Chinese (not_seller / unregistered).
      return body.message ?? "你没有卖家权限，收款码未上传。";
    }
    if (resp.status === 400) {
      return "图片格式不支持或过大（支持 png/jpeg/webp，≤512KB），请重新发送。";
    }
    return `收款码上传失败（HTTP ${resp.status}），请稍后再试。`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `收款码上传失败（${msg}），请稍后再试。`;
  } finally {
    clearTimeout(timer);
  }
}

async function loadMediaBytes(request: QrUploadRequest, options: QrUploadOptions): Promise<Buffer> {
  if (request.mediaPath) {
    const read = options.readFileImpl ?? readFile;
    return read(request.mediaPath);
  }
  // mediaUrl fallback (host did not download locally).
  const fetchImpl = options.fetchImpl ?? fetch;
  const resp = await fetchImpl(request.mediaUrl as string);
  if (!resp.ok) {
    throw new Error(`media fetch HTTP ${resp.status}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

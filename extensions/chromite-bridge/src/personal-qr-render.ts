// C-lite personal QR reply decoration — spec chromite-personal-qr-openclaw-wiring-v1.
//
// Pure-ish assembly (fetch injected, no native addon import) so the projection
// render → reply mapping is unit-testable without driving the napi edge loop.

import type { ProjectionButtonsBlock, ProjectionRender } from "./projection-engine.js";

export type DecoratedReply = {
  reply: string;
  buttons: ProjectionButtonsBlock | null;
  /** Seller payment QR image URL on chromite (attach as ReplyPayload.mediaUrl). */
  mediaUrl?: string;
  /** Payment collection code is live-only media; do not persist the reference. */
  sensitiveMedia?: boolean;
};

export async function decorateReplyWithProjection(options: {
  reply: string;
  render: ProjectionRender;
  chromiteUrl: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<DecoratedReply> {
  const { reply, render } = options;
  switch (render.kind) {
    case "buttons":
      return { reply, buttons: render.block };
    case "personal_qr": {
      // Pre-validate the image is fetchable now (fail-visible: the buyer must
      // know the code is missing, not silently see plain text); outbound
      // delivery re-fetches the URL (loopback double-fetch is negligible).
      const base = options.chromiteUrl.replace(/\/+$/, "");
      const qrUrl = `${base}/v1/commerce/seller-payment-qr/${encodeURIComponent(render.qrRef)}`;
      let qrOk = false;
      try {
        const probe = await options.fetchImpl(qrUrl, { signal: options.signal });
        qrOk = probe.ok;
      } catch {
        qrOk = false;
      }
      const amountLine =
        render.amountCents !== null ? `应付金额：¥${(render.amountCents / 100).toFixed(2)}\n` : "";
      if (qrOk) {
        return {
          reply: `${reply}\n\n${amountLine}${render.instructions}`,
          buttons: null,
          mediaUrl: qrUrl,
          sensitiveMedia: true,
        };
      }
      return {
        reply: `${reply}\n\n${amountLine}⚠️ 收款码加载失败，请让卖家重新发送收款码后再试。`,
        buttons: null,
      };
    }
    case "unsupported":
      // Minimal profile-dispatch degrade: never silently drop a projection the
      // backend expected the buyer to see (interaction-projection-v1 deferred
      // registry, first consumer = C-lite).
      return {
        reply: `${reply}\n\n（此交互界面（${render.profile}）当前客户端暂不支持显示，请联系卖家或稍后再试。）`,
        buttons: null,
      };
    case "none":
      return { reply, buttons: null };
  }
}

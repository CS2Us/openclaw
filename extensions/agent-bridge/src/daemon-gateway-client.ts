// Loopback WebSocket client used by agent-bridge daemon-side code to invoke
// gateway methods on itself.
//
// Why this exists:
//   The interactive handler runs *inside* the daemon process, which IS the
//   gateway. When the user taps a button on our own approval card we need to
//   resolve the openclaw approval state so perm-hook.cjs's `waitDecision`
//   returns immediately. The plugin SDK doesn't expose a synchronous in-
//   process resolveApproval, so we connect a tiny WS client back to
//   ws://127.0.0.1:18789 and use it the same way perm-hook does.
//
// Design:
//   - Singleton per process. Lazy connect on first call.
//   - Auto-reconnect on disconnect; in-flight requests get a rejected
//     promise (caller falls back to file IPC if it wants).
//   - Mirrors the request/response protocol from perm-hook.cjs:
//     `{type:"req", id, method, params}` → `{type:"res", id, ok, payload}`.
//
// Trade-off vs file IPC + perm-hook polling:
//   Saves ~150-300ms file-poll latency + ~50ms WS RTT in the perm-hook side.
//   See docs/specs/2026-05-12-agent-bridge-contextual-approval.md "Option B"
//   chain optimization.

import WebSocket from "ws";
import type { ApprovalDecision } from "./tab-manager-ui.js";

type Pending = {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
};

export type DaemonGatewayClient = {
  /**
   * Resolves an openclaw plugin approval. Forwarded to gateway method
   * `plugin.approval.resolve`. Throws if the WS connection is unavailable
   * or the gateway returns an error.
   */
  resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  /**
   * Eagerly open the WS connection without blocking the caller. Used at
   * plugin init so the `operator.approvals` scope is registered *before*
   * perm-hook fires its first plugin.approval.request — otherwise the
   * gateway's `hasExecApprovalClients` check returns false and the approval
   * auto-expires with reason "no-approval-route". See
   * src/gateway/server-methods/approval-shared.ts handlePendingApprovalRequest.
   */
  connectEagerly(): void;
};

let singleton: DaemonGatewayClient | null = null;

/**
 * Returns the singleton client, or null if env doesn't provide the gateway
 * password (callers should fall back to file IPC in that case).
 */
export function getDaemonGatewayClient(): DaemonGatewayClient | null {
  if (singleton) return singleton;
  const password = process.env.OPENCLAW_GATEWAY_PASSWORD?.trim();
  const url = process.env.OPENCLAW_GATEWAY_URL?.trim() || "ws://127.0.0.1:18789";
  if (!password) return null;
  singleton = createClient(url, password);
  return singleton;
}

function createClient(url: string, password: string): DaemonGatewayClient {
  let ws: WebSocket | null = null;
  let connectPromise: Promise<void> | null = null;
  const inflight = new Map<string, Pending>();
  let nextId = 1;

  const failInflight = (reason: string): void => {
    for (const pending of inflight.values()) {
      pending.reject(new Error(reason));
    }
    inflight.clear();
  };

  const attachWs = (socket: WebSocket): void => {
    socket.on("message", (data) => {
      let msg: {
        type?: string;
        id?: string;
        ok?: boolean;
        payload?: unknown;
        error?: { code?: string; message?: string };
      };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type !== "res" || typeof msg.id !== "string") return;
      const pending = inflight.get(msg.id);
      if (!pending) return;
      inflight.delete(msg.id);
      if (msg.ok) {
        pending.resolve(msg.payload);
      } else {
        const code = msg.error?.code ?? "ERR";
        const message = msg.error?.message ?? "unknown";
        pending.reject(new Error(`${code}: ${message}`));
      }
    });
    socket.on("close", () => {
      if (ws === socket) {
        ws = null;
      }
      failInflight("daemon-gateway ws closed");
    });
    socket.on("error", (err) => {
      process.stderr.write(`[daemon-gateway] ws error: ${String(err)}\n`);
    });
  };

  const ensureConnected = async (): Promise<void> => {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    if (connectPromise) return connectPromise;
    connectPromise = (async () => {
      const socket = new WebSocket(url);
      attachWs(socket);
      ws = socket;
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("close", () => reject(new Error("daemon-gateway ws closed before open")));
      });
      // `client.id` must match GATEWAY_CLIENT_IDS enum (see
      // src/gateway/protocol/client-info.ts). Use "gateway-client" — the
      // generic backend client id, same as perm-hook.cjs. Sending an
      // arbitrary string fails handshake validation.
      await sendReq("connect", {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "gateway-client",
          version: "1.0.0",
          platform: "node",
          mode: "backend",
        },
        scopes: ["operator.approvals"],
        auth: { password },
      });
    })().finally(() => {
      connectPromise = null;
    });
    return connectPromise;
  };

  const sendReq = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      const socket = ws;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error("daemon-gateway ws not connected"));
        return;
      }
      const id = `dg${nextId++}`;
      inflight.set(id, { resolve, reject });
      socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  };

  return {
    async resolveApproval(approvalId: string, decision: ApprovalDecision) {
      await ensureConnected();
      await sendReq("plugin.approval.resolve", { id: approvalId, decision });
    },
    connectEagerly(): void {
      // Eager connect with retry: plugin.register() runs *before* the http
      // server starts listening, so the first attempt always ECONNREFUSEs.
      // Retry every 500ms up to ~15s — by then the gateway is up. Past that
      // we give up and rely on resolveApproval's own connect-on-demand.
      let attempt = 0;
      const tryConnect = (): void => {
        attempt += 1;
        ensureConnected().catch((err) => {
          if (attempt >= 30) {
            process.stderr.write(
              `[daemon-gateway] eager connect gave up after ${attempt} attempts: ${String(err)}\n`,
            );
            return;
          }
          setTimeout(tryConnect, 500);
        });
      };
      tryConnect();
    },
  };
}

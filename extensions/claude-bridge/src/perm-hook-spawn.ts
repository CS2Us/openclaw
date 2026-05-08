// Glue between fallthrough/command and the perm-hook.cjs runtime entry.
// - Resolves the hook script's absolute path inside the plugin install tree
//   (must be absolute because claude resolves the `command` field relative to
//   its own cwd, not ours).
// - Builds the env that the hook child reads to forward routing context to
//   plugin.approval.request. See spec §3.6 for the env contract.

import { fileURLToPath } from "node:url";

export type PermHookRoutingContext = {
  channel: string;
  chatId: string;
  agentId?: string;
  sessionKey?: string;
  accountId?: string;
  threadId?: string | number;
};

export function resolvePermHookScriptPath(): string {
  // src/perm-hook-spawn.ts → ../scripts/perm-hook.cjs
  return fileURLToPath(new URL("../scripts/perm-hook.cjs", import.meta.url));
}

export function buildPermHookEnv(params: {
  gatewayUrl?: string;
  gatewayPassword: string;
  routing: PermHookRoutingContext;
}): Record<string, string> {
  const env: Record<string, string> = {
    OPENCLAW_GATEWAY_URL: params.gatewayUrl?.trim() || "ws://127.0.0.1:18789",
    OPENCLAW_GATEWAY_PASSWORD: params.gatewayPassword,
    OPENCLAW_TURN_AGENT_ID: params.routing.agentId ?? "claude-bridge",
    OPENCLAW_TURN_SESSION_KEY:
      params.routing.sessionKey ?? `${params.routing.channel}:${params.routing.chatId}`,
    OPENCLAW_TURN_SOURCE_CHANNEL: params.routing.channel,
    OPENCLAW_TURN_SOURCE_TO: params.routing.chatId,
    OPENCLAW_TURN_SOURCE_ACCOUNT_ID: params.routing.accountId ?? "default",
  };
  if (params.routing.threadId !== undefined && params.routing.threadId !== null) {
    const tid = String(params.routing.threadId);
    if (tid.length > 0) {
      env.OPENCLAW_TURN_SOURCE_THREAD_ID = tid;
    }
  }
  return env;
}

export function resolveGatewayPassword(): string | undefined {
  // v1: read from process.env. openclaw-start.sh already injects
  // OPENCLAW_GATEWAY_PASSWORD into the daemon process env (see
  // scripts/openclaw-start.sh in the parent telegram repo).
  // Future: read from plugin SDK secret resolver if/when available.
  const fromEnv = process.env.OPENCLAW_GATEWAY_PASSWORD?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

export function resolveGatewayUrl(): string | undefined {
  return process.env.OPENCLAW_GATEWAY_URL?.trim() || undefined;
}

// Glue between fallthrough/command and the perm-hook.cjs runtime entry.
// - Resolves the hook script's absolute path inside the plugin install tree
//   (must be absolute because claude resolves the `command` field relative to
//   its own cwd, not ours).
// - Builds the env that the hook child reads to forward routing context to
//   plugin.approval.request. See spec §3.6 for the env contract.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type PermHookRoutingContext = {
  channel: string;
  chatId: string;
  agentId?: string;
  sessionKey?: string;
  accountId?: string;
  threadId?: string | number;
};

/**
 * Locate the runtime hook script. The lookup spans both source-tree (tsx /
 * dev runs) and dist-bundle (production) layouts because openclaw's bundler
 * collapses extension chunks: `import.meta.url` at runtime is no longer a
 * stable proxy for "this plugin's install dir". We probe candidate paths
 * walking up from `import.meta.url` and return the first one that exists.
 */
export function resolvePermHookScriptPath(): string | undefined {
  const here = fileURLToPath(import.meta.url);
  const dir = path.dirname(here);
  const candidates = [
    // Source-tree layout: extensions/agent-bridge/src/* → ../scripts/.
    path.join(dir, "..", "scripts", "perm-hook.cjs"),
    // Bundled dist where staticAssets restore the canonical plugin folder
    // (extensions/<plugin>/scripts/...). Look up two levels then descend
    // through `agent-bridge/scripts/`.
    path.join(dir, "..", "agent-bridge", "scripts", "perm-hook.cjs"),
    // Same recovery one level higher (when bundler nests deeper).
    path.join(dir, "..", "..", "agent-bridge", "scripts", "perm-hook.cjs"),
    // dist root recovery: <cwd>/dist/extensions/agent-bridge/scripts/...
    path.join(dir, "..", "..", "..", "extensions", "agent-bridge", "scripts", "perm-hook.cjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function buildPermHookEnv(params: {
  gatewayUrl?: string;
  gatewayPassword: string;
  routing: PermHookRoutingContext;
}): Record<string, string> {
  const env: Record<string, string> = {
    OPENCLAW_GATEWAY_URL: params.gatewayUrl?.trim() || "ws://127.0.0.1:18789",
    OPENCLAW_GATEWAY_PASSWORD: params.gatewayPassword,
    OPENCLAW_TURN_AGENT_ID: params.routing.agentId ?? "agent-bridge",
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
  // Companion message ("session X waiting on approval, [👁 enter]") needs to
  // hit Telegram bot API directly — gateway 'send' doesn't carry inline-keyboard
  // payloads. Daemon ships TG_BOT_TOKEN via openclaw-start.sh, forward it on
  // when the hook routes through a telegram chat.
  const tgToken = process.env.TG_BOT_TOKEN?.trim();
  if (tgToken && params.routing.channel === "telegram") {
    env.TG_BOT_TOKEN = tgToken;
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

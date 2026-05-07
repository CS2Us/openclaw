import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import {
  clearPluginInboundFallthroughHandlersState,
  getPluginInboundFallthroughHandlersState,
  type RegisteredInboundFallthroughHandler,
} from "./inbound-fallthrough-state.js";
import type { PluginInboundFallthroughHandlerRegistration } from "./types.js";

export type InboundFallthroughRegistrationResult = {
  ok: boolean;
  error?: string;
};

function normalizeChannel(channel: string | undefined): string {
  return normalizeOptionalLowercaseString(channel) ?? "";
}

export function resolvePluginInboundFallthroughHandler(
  channel: string,
): RegisteredInboundFallthroughHandler | null {
  const key = normalizeChannel(channel);
  if (!key) {
    return null;
  }
  const handlers = getPluginInboundFallthroughHandlersState();
  return handlers.get(key) ?? null;
}

export function registerPluginInboundFallthroughHandler(
  pluginId: string,
  registration: PluginInboundFallthroughHandlerRegistration,
  opts?: { pluginName?: string; pluginRoot?: string },
): InboundFallthroughRegistrationResult {
  const channel = normalizeChannel(registration.channel);
  if (!channel) {
    return { ok: false, error: "Inbound fallthrough handler must specify a channel" };
  }
  if (typeof registration.handler !== "function") {
    return { ok: false, error: "Inbound fallthrough handler must be a function" };
  }
  const handlers = getPluginInboundFallthroughHandlersState();
  const existing = handlers.get(channel);
  if (existing) {
    return {
      ok: false,
      error: `Inbound fallthrough handler for channel "${channel}" already registered by plugin "${existing.pluginId}"`,
    };
  }
  handlers.set(channel, {
    ...registration,
    channel,
    pluginId,
    pluginName: opts?.pluginName,
    pluginRoot: opts?.pluginRoot,
  });
  return { ok: true };
}

export function clearPluginInboundFallthroughHandlersForPlugin(pluginId: string): void {
  const handlers = getPluginInboundFallthroughHandlersState();
  for (const [key, value] of handlers.entries()) {
    if (value.pluginId === pluginId) {
      handlers.delete(key);
    }
  }
}

export function clearPluginInboundFallthroughHandlers(): void {
  clearPluginInboundFallthroughHandlersState();
}

export function listPluginInboundFallthroughHandlers(): RegisteredInboundFallthroughHandler[] {
  return Array.from(getPluginInboundFallthroughHandlersState().values());
}

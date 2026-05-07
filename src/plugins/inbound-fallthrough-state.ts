import type { PluginInboundFallthroughHandlerRegistration } from "./types.js";

export type RegisteredInboundFallthroughHandler = PluginInboundFallthroughHandlerRegistration & {
  pluginId: string;
  pluginName?: string;
  pluginRoot?: string;
};

type InboundFallthroughState = {
  // Keyed by lowercased channel id (e.g. "telegram"). Single handler per channel.
  handlers: Map<string, RegisteredInboundFallthroughHandler>;
};

const PLUGIN_INBOUND_FALLTHROUGH_STATE_KEY = Symbol.for("openclaw.pluginInboundFallthroughState");

function createState(): InboundFallthroughState {
  return { handlers: new Map<string, RegisteredInboundFallthroughHandler>() };
}

function hydrateState(value: unknown): InboundFallthroughState {
  const state =
    typeof value === "object" && value !== null
      ? (value as Partial<InboundFallthroughState>)
      : ({} as Partial<InboundFallthroughState>);
  return {
    handlers:
      state.handlers instanceof Map
        ? state.handlers
        : new Map<string, RegisteredInboundFallthroughHandler>(),
  };
}

function getState(): InboundFallthroughState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[PLUGIN_INBOUND_FALLTHROUGH_STATE_KEY];
  if (existing !== undefined) {
    const hydrated = hydrateState(existing);
    globalStore[PLUGIN_INBOUND_FALLTHROUGH_STATE_KEY] = hydrated;
    return hydrated;
  }
  const created = createState();
  globalStore[PLUGIN_INBOUND_FALLTHROUGH_STATE_KEY] = created;
  return created;
}

export function getPluginInboundFallthroughHandlersState() {
  return getState().handlers;
}

export function clearPluginInboundFallthroughHandlersState(): void {
  getPluginInboundFallthroughHandlersState().clear();
}

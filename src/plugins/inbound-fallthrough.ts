// Public plugin-runtime barrel for the inbound-fallthrough seam. Other
// extensions (e.g. telegram channel plugin) consume this to look up a
// registered handler before invoking the default agent loop.

import { resolvePluginInboundFallthroughHandler } from "./inbound-fallthrough-registry.js";
import type { RegisteredInboundFallthroughHandler } from "./inbound-fallthrough-state.js";
import type { PluginInboundFallthroughEvent, PluginInboundFallthroughResult } from "./types.js";

export type {
  PluginInboundFallthroughEvent,
  PluginInboundFallthroughHandler,
  PluginInboundFallthroughHandlerRegistration,
  PluginInboundFallthroughResult,
} from "./types.js";
export {
  clearPluginInboundFallthroughHandlers,
  clearPluginInboundFallthroughHandlersForPlugin,
  listPluginInboundFallthroughHandlers,
  registerPluginInboundFallthroughHandler,
  resolvePluginInboundFallthroughHandler,
  type InboundFallthroughRegistrationResult,
} from "./inbound-fallthrough-registry.js";

export type InboundFallthroughDispatchResult =
  | { matched: false; handled: false }
  | {
      matched: true;
      handled: boolean;
      reply: string | null;
      registration: RegisteredInboundFallthroughHandler;
    };

/**
 * Channel-side dispatcher: look up the registered fallthrough handler for
 * `event.channel` and invoke it. Errors from the handler are caught and
 * reported through `onError` (so the channel main loop is not impacted).
 */
export async function dispatchPluginInboundFallthroughHandler(params: {
  event: PluginInboundFallthroughEvent;
  onError?: (error: unknown, registration: RegisteredInboundFallthroughHandler) => void;
}): Promise<InboundFallthroughDispatchResult> {
  const registration = resolvePluginInboundFallthroughHandler(params.event.channel);
  if (!registration) {
    return { matched: false, handled: false };
  }
  let result: PluginInboundFallthroughResult;
  try {
    result = await registration.handler(params.event);
  } catch (error) {
    params.onError?.(error, registration);
    return {
      matched: true,
      handled: false,
      reply: null,
      registration,
    };
  }
  if (result.handled) {
    return {
      matched: true,
      handled: true,
      reply: result.reply ?? null,
      registration,
    };
  }
  return { matched: true, handled: false, reply: null, registration };
}

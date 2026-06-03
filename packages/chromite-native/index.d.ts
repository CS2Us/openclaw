// Public type surface for the chromite-client-napi addon.
//
// Mirrors the NAPI-RS-generated `index.d.ts` in
// src/chromite/crates/chromite-client-napi/index.d.ts (kept in sync by hand so
// the openclaw workspace package is self-describing without crossing the repo
// boundary in a `.d.ts` re-export). napi-derive maps snake_case Rust fields to
// camelCase JS keys.

/**
 * Edge loop config marshaled across the JS<->Rust boundary.
 */
export interface EdgeLoopConfigJs {
  /** chromite base url (no trailing slash; modules append `/v1/...`). */
  baseUrl: string;
  /** identity channel (v1 always "telegram"; empty -> falls back to "telegram"). */
  channel: string;
  /** channel-scoped user id; v1 session token = channel_user_id. */
  channelUserId: string;
  /** loop turn cap (0 / absent -> core clamps to default 8). */
  maxTurns?: number;
  /**
   * authoritative commerce tool-name manifest (C1). Names NOT listed fail-soft
   * to "unknown tool" and never hit HTTP. openclaw has no device tools, so the
   * client set is empty and every listed name routes to the server commerce RPC.
   */
  serverTools: Array<string>;
  /**
   * OPT-IN durable resilience (sub-spec 4 R1). When set, the native loop uses a
   * FilePendingStore rooted here + run_edge_loop_resumable: an interrupted loop
   * (transport error after a tool dispatch) persists a per-`convId` snapshot and a
   * later call with the SAME `convId` restores + continues it. Absent -> the
   * existing non-resumable path (in-memory store, no cross-call durability).
   *
   * (!) HUMAN GATE: restore RE-SENDS the gateway turn and can re-dispatch a
   * non-idempotent commerce tool already dispatched before the interruption ->
   * duplicate side-effects (e.g. double charge). Enabling in production REQUIRES
   * backend commerce idempotency. The bridge gates this behind the
   * `CHROMITE_PENDING_STORE_DIR` operator env flag, defaulting off.
   */
  pendingStoreDir?: string;
}

/**
 * `run_edge_loop` terminal result marshaled out.
 */
export interface EdgeLoopResultJs {
  reply: string;
  iterations: number;
  hitMaxTurns: boolean;
}

/** `resolve` result marshaled out. */
export interface IdentityResolveJs {
  userId: string;
  provisional: boolean;
}

/**
 * `POST /v1/identity/resolve` — bind (channel, channel_user_id) so the zero-trust
 * commerce RPCs resolve. Rejects with the verbatim TS-parity message on failure.
 */
export declare function resolveIdentity(cfg: EdgeLoopConfigJs): Promise<IdentityResolveJs>;

/**
 * Run the edge agent loop: gateway SSE turn <-> /v1/commerce zero-trust RPC,
 * until the LLM stops calling tools (final reply) or hits max_turns. Rejects with
 * the verbatim Rust `ClientError` message on transport failure.
 */
export declare function runEdgeLoopNapi(
  userMsg: string,
  convId: string,
  cfg: EdgeLoopConfigJs,
): Promise<EdgeLoopResultJs>;

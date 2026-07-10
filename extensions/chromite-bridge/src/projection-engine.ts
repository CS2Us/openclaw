/** Interaction Projection Protocol v1 renderer/executor for chromite-bridge. */

import { randomUUID } from "node:crypto";
import type { InteractionRuntimeMode } from "./config.js";

export type ClientAction = {
  kind: string;
  version: number;
  projection: unknown;
};

export type PayOutcome = "succeed" | "fail";

export const PAY_CONFIRM_COMMAND = "/chromite-pay";

export type ProjectionButtonsBlock = {
  type: "buttons";
  buttons: Array<{
    label: string;
    value: string;
    style?: "primary" | "secondary" | "success" | "danger";
  }>;
};

type JsonRecord = Record<string, unknown>;

/**
 * Who a pending-operation token was minted for. Redemption is bound to this
 * principal (see takePendingPayOperation) so a token cannot be redeemed by
 * another user. `senderId` is the channel-scoped user id; `accountId` is the bot
 * account (multi-bot isolation).
 */
export type OperationPrincipal = {
  accountId?: string;
  senderId: string;
};

export type PendingOperation = {
  actionId: string;
  operationRef: string;
  kind: string;
  params: JsonRecord;
  createdAtMs: number;
  /** Principal this token was minted for; verified at redemption. */
  principal: OperationPrincipal;
};

const OP_CONFIRM_PAYMENT = "mock_payment_gateway.confirm_intent.v1";
const ALLOWED_OPERATION_KINDS = new Set([OP_CONFIRM_PAYMENT]);
const PENDING_OPERATION_TTL_MS = 15 * 60 * 1000;

const pendingOperations = new Map<string, PendingOperation>();

export function buildInteractionButtons(
  clientActions: ClientAction[] | undefined,
  principal: OperationPrincipal,
  options: { runtimeMode?: InteractionRuntimeMode } = {},
): ProjectionButtonsBlock | null {
  const action = (clientActions ?? []).find((a) => a.kind === "interaction_projection");
  if (!action) {
    return null;
  }

  if (action.version !== 1 || !isRecord(action.projection)) {
    return null;
  }

  const projection = action.projection;
  const actions = Array.isArray(projection.actions) ? projection.actions : [];
  const operations = isRecord(projection.operations) ? projection.operations : {};
  const buttons: ProjectionButtonsBlock["buttons"] = [];

  purgeExpiredPendingOperations();

  for (const item of actions) {
    if (!isRecord(item)) {
      continue;
    }
    const actionId = readString(item.id);
    const label = readString(item.label);
    const operationRef = readString(item.operation_ref);
    if (!actionId || !label || !operationRef) {
      continue;
    }

    const operation = operations[operationRef];
    if (!isRecord(operation)) {
      continue;
    }
    const kind = readString(operation.kind);
    if (!kind || !ALLOWED_OPERATION_KINDS.has(kind)) {
      continue;
    }

    const runtimeMode = options.runtimeMode ?? "local-b3";
    const token =
      runtimeMode === "chromite-b1"
        ? readString(item.operation_token)
        : rememberLocalPendingOperation(projection, operation, {
            actionId,
            operationRef,
            kind,
            createdAtMs: Date.now(),
            principal,
          });
    if (!token) {
      continue;
    }

    buttons.push({
      label,
      value: `${PAY_CONFIRM_COMMAND} ${token}`,
      style: toButtonStyle(item),
    });
  }

  return buttons.length > 0 ? { type: "buttons", buttons } : null;
}

/**
 * Minimal presentation-profile dispatch (interaction-projection-v1 §v1
 * boundaries deferred item; trigger = C-lite personal QR,
 * spec chromite-personal-qr-openclaw-wiring-v1).
 *
 * Behavior-preserving order:
 *   1. Buttons first — any allowlisted action renders exactly as before
 *      (confirm.v1 / B3 / B1 output byte-identical via buildInteractionButtons).
 *   2. No buttons + known render-only profile → profile-specific descriptor.
 *   3. No buttons + unknown non-empty profile → "unsupported" (text degrade;
 *      fixes the silent-invisible gap for future profiles).
 *   4. No projection at all → "none".
 */
export type ProjectionRender =
  | { kind: "buttons"; block: ProjectionButtonsBlock }
  | {
      kind: "personal_qr";
      qrRef: string;
      contentType: string | null;
      instructions: string;
      amountCents: number | null;
    }
  | { kind: "unsupported"; profile: string }
  | { kind: "none" };

export const PERSONAL_QR_PROFILE = "checkout.payment.personal_qr.v1";

export function renderProjection(
  clientActions: ClientAction[] | undefined,
  principal: OperationPrincipal,
  options: { runtimeMode?: InteractionRuntimeMode } = {},
): ProjectionRender {
  const buttons = buildInteractionButtons(clientActions, principal, options);
  if (buttons) {
    return { kind: "buttons", block: buttons };
  }

  const action = (clientActions ?? []).find((a) => a.kind === "interaction_projection");
  if (!action || action.version !== 1 || !isRecord(action.projection)) {
    return { kind: "none" };
  }
  const projection = action.projection;
  const presentation = isRecord(projection.presentation) ? projection.presentation : {};
  const profile = readString(presentation.profile);
  if (!profile) {
    return { kind: "none" };
  }

  if (profile === PERSONAL_QR_PROFILE) {
    const sellerPayment = isRecord(presentation.seller_payment) ? presentation.seller_payment : {};
    const qrRef = readString(sellerPayment.qr_ref);
    // Backend-owned contract: mode + qr_ref must both be present; anything else
    // is a malformed projection → degrade to "unsupported" rather than guessing.
    if (sellerPayment.mode !== "personal_qr_clite" || !qrRef) {
      return { kind: "unsupported", profile };
    }
    const amount = isRecord(presentation.amount) ? presentation.amount : {};
    return {
      kind: "personal_qr",
      qrRef,
      contentType: readString(sellerPayment.qr_content_type),
      instructions:
        readString(sellerPayment.instructions) ??
        "请扫码向卖家直接付款；卖家确认收款后订单继续推进。",
      amountCents: typeof amount.value_cents === "number" ? amount.value_cents : null,
    };
  }

  return { kind: "unsupported", profile };
}

function rememberLocalPendingOperation(
  projection: JsonRecord,
  operation: JsonRecord,
  base: Omit<PendingOperation, "params">,
): string | null {
  const params = resolveOperationParams(projection, operation);
  if (!params || !validateParamsSchema(operation.params_schema, params)) {
    return null;
  }
  return rememberPendingOperation({ ...base, params });
}

export function parsePayConfirm(value: string): { token: string } | null {
  const parts = value.trim().split(/\s+/);
  if (parts[0] !== PAY_CONFIRM_COMMAND || parts.length !== 2 || !parts[1]) {
    return null;
  }
  return { token: parts[1] };
}

export async function executePayOperation(
  token: string,
  mockGatewayUrl: string,
  caller: OperationPrincipal,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; outcome: PayOutcome }> {
  const operation = takePendingPayOperation(token, caller);
  if (!operation) {
    throw new Error("payment operation token not found or expired");
  }
  if (operation.kind !== OP_CONFIRM_PAYMENT) {
    throw new Error(`operation kind is not allowed: ${operation.kind}`);
  }

  const intentId = operation.params.intent_id;
  const outcome = operation.params.outcome;
  if (typeof intentId !== "string" || !isPayOutcome(outcome)) {
    throw new Error("payment operation params are invalid");
  }

  const result = await confirmPaymentIntent(mockGatewayUrl, intentId, outcome, fetchImpl);
  return { ...result, outcome };
}

export function takePendingPayOperation(
  token: string,
  caller: OperationPrincipal,
): PendingOperation | null {
  purgeExpiredPendingOperations();
  const operation = pendingOperations.get(token);
  if (!operation) {
    return null;
  }
  // principal binding: only the principal the token was minted for may redeem it.
  // A mismatch is treated as not-found and does NOT consume the token, so a probe
  // by another user cannot burn the real owner's pending operation.
  if (!principalMatches(operation.principal, caller)) {
    return null;
  }
  pendingOperations.delete(token);
  return operation;
}

export function clearPendingPayOperations(): void {
  pendingOperations.clear();
}

export async function confirmPaymentIntent(
  mockGatewayUrl: string,
  intentId: string,
  outcome: PayOutcome,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const base = mockGatewayUrl.replace(/\/+$/, "");
  const url = `${base}/v1/payment_intents/${encodeURIComponent(intentId)}/confirm`;
  const resp = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ outcome }),
  });
  return { ok: resp.ok, status: resp.status };
}

function resolveOperationParams(projection: JsonRecord, operation: JsonRecord): JsonRecord | null {
  const paramsSpec = operation.params;
  if (!isRecord(paramsSpec)) {
    return null;
  }

  const resolved: JsonRecord = {};
  for (const [key, binding] of Object.entries(paramsSpec)) {
    const value = resolveBinding(projection, binding);
    if (value === undefined) {
      return null;
    }
    resolved[key] = value;
  }
  return resolved;
}

function resolveBinding(projection: JsonRecord, binding: unknown): unknown {
  if (!isRecord(binding)) {
    return binding;
  }
  if (Object.prototype.hasOwnProperty.call(binding, "$const")) {
    return binding.$const;
  }
  const fromPath = readString(binding.$from);
  if (fromPath) {
    return readPath(projection, fromPath);
  }
  const secretPath = readString(binding.$secret);
  if (secretPath) {
    const secrets = isRecord(projection.secrets) ? projection.secrets : {};
    return readPath(secrets, secretPath);
  }
  return undefined;
}

function validateParamsSchema(schema: unknown, params: JsonRecord): boolean {
  if (!isRecord(schema) || schema.type !== "object") {
    return false;
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key !== "string" || !(key in params)) {
      return false;
    }
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(params)) {
      if (!(key in properties)) {
        return false;
      }
    }
  }

  for (const [key, value] of Object.entries(params)) {
    const property = properties[key];
    if (isRecord(property) && !validateProperty(property, value)) {
      return false;
    }
  }

  return true;
}

function validateProperty(schema: JsonRecord, value: unknown): boolean {
  if (schema.type === "string") {
    if (typeof value !== "string") {
      return false;
    }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return false;
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      return false;
    }
  }
  if (schema.type === "number" && typeof value !== "number") {
    return false;
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    return false;
  }
  return true;
}

function rememberPendingOperation(operation: PendingOperation): string {
  // CSPRNG token (unguessable / unenumerable) + principal binding on the stored
  // entry are the two guards that make this token safe to hand out. The store is
  // still in-process / single-daemon / TTL-bounded (spec 2026-07-01 §v1
  // Implementation Boundaries) — those remain v1 constraints, not security holes.
  const token = `op_${randomUUID()}`;
  pendingOperations.set(token, operation);
  return token;
}

function principalMatches(a: OperationPrincipal, b: OperationPrincipal): boolean {
  return a.senderId === b.senderId && (a.accountId ?? "") === (b.accountId ?? "");
}

function purgeExpiredPendingOperations(now = Date.now()): void {
  for (const [token, operation] of pendingOperations) {
    if (now - operation.createdAtMs > PENDING_OPERATION_TTL_MS) {
      pendingOperations.delete(token);
    }
  }
}

function toButtonStyle(action: JsonRecord): ProjectionButtonsBlock["buttons"][number]["style"] {
  const style = isRecord(action.style) ? action.style : {};
  const tone = readString(style.tone);
  const intent = readString(action.intent);
  if (tone === "danger") {
    return "danger";
  }
  if (tone === "success" || intent === "primary") {
    return "primary";
  }
  return "secondary";
}

function isPayOutcome(v: unknown): v is PayOutcome {
  return v === "succeed" || v === "fail";
}

function readPath(root: JsonRecord, path: string): unknown {
  let cursor: unknown = root;
  for (const segment of path.split(".")) {
    if (!segment || !isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

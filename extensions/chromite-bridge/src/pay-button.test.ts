import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildInteractionButtons,
  clearPendingPayOperations,
  confirmPaymentIntent,
  executePayOperation,
  parsePayConfirm,
  PAY_CONFIRM_COMMAND,
  type ClientAction,
} from "./projection-engine.js";

function projectionAction(overrides: Record<string, unknown> = {}): ClientAction {
  const projection = {
    id: "ip_test",
    domain: "commerce",
    surface: "checkout",
    entity: {
      type: "payment_intent",
      id: "pi_x",
      state: "requires_buyer_confirmation",
      refs: { order_id: "ord_x", payment_id: "pay_x" },
    },
    presentation: {
      profile: "checkout.payment.confirm.v1",
      layout: "confirmation_card",
      title: "确认支付",
    },
    actions: [
      {
        id: "confirm_payment",
        label: "确认支付",
        intent: "primary",
        style: { tone: "success" },
        operation_ref: "op_confirm_payment",
      },
      {
        id: "simulate_payment_failure",
        label: "模拟失败",
        intent: "secondary",
        operation_ref: "op_simulate_payment_failure",
      },
    ],
    operations: {
      op_confirm_payment: operation("succeed"),
      op_simulate_payment_failure: operation("fail"),
    },
    secrets: { client_secret: "sek_should_not_leak" },
    ...overrides,
  };

  return {
    kind: "interaction_projection",
    version: 1,
    projection,
  };
}

function operation(outcome: "succeed" | "fail", overrides: Record<string, unknown> = {}) {
  return {
    kind: "mock_payment_gateway.confirm_intent.v1",
    params_schema: {
      type: "object",
      required: ["intent_id", "outcome"],
      additionalProperties: false,
      properties: {
        intent_id: { type: "string", minLength: 1 },
        outcome: { type: "string", enum: ["succeed", "fail"] },
      },
    },
    params: {
      intent_id: { $from: "entity.id" },
      outcome: { $const: outcome },
    },
    ...overrides,
  };
}

const PRINCIPAL = { accountId: "acct1", senderId: "user1" };

beforeEach(() => {
  clearPendingPayOperations();
});

describe("buildInteractionButtons", () => {
  it("renders projection actions as tokenized buttons", () => {
    const block = buildInteractionButtons([projectionAction()], PRINCIPAL);

    expect(block).not.toBeNull();
    expect(block!.type).toBe("buttons");
    expect(block!.buttons).toHaveLength(2);
    expect(block!.buttons[0].label).toBe("确认支付");
    expect(block!.buttons[0].value).toMatch(new RegExp(`^${PAY_CONFIRM_COMMAND} op_`));
    expect(block!.buttons[1].value).toMatch(new RegExp(`^${PAY_CONFIRM_COMMAND} op_`));
  });

  it("SECRET DISCIPLINE: button values never include params or secrets", () => {
    const block = buildInteractionButtons([projectionAction()], PRINCIPAL);
    const serialized = JSON.stringify(block);

    expect(serialized).not.toContain("sek_should_not_leak");
    expect(serialized).not.toContain("client_secret");
    expect(serialized).not.toContain("pi_x");
    expect(serialized).not.toContain("succeed");
    expect(serialized).not.toContain("fail");
  });

  it("returns null for absent, malformed, or legacy client actions", () => {
    expect(buildInteractionButtons([], PRINCIPAL)).toBeNull();
    expect(buildInteractionButtons(undefined, PRINCIPAL)).toBeNull();
    expect(
      buildInteractionButtons([{ kind: "payment_request", version: 1, projection: {} }], PRINCIPAL),
    ).toBeNull();
    expect(
      buildInteractionButtons(
        [{ kind: "interaction_projection", version: 1, projection: null }],
        PRINCIPAL,
      ),
    ).toBeNull();
  });

  it("skips operations that are not allowlisted", () => {
    const block = buildInteractionButtons(
      [
        projectionAction({
          operations: {
            op_confirm_payment: operation("succeed", { kind: "unknown.operation.v1" }),
          },
        }),
      ],
      PRINCIPAL,
    );

    expect(block).toBeNull();
  });

  it("skips actions when resolved params do not satisfy params_schema", () => {
    const block = buildInteractionButtons(
      [
        projectionAction({
          operations: {
            op_confirm_payment: operation("succeed", {
              params: {
                intent_id: { $from: "entity.id" },
                outcome: { $const: "bogus" },
              },
            }),
          },
        }),
      ],
      PRINCIPAL,
    );

    expect(block).toBeNull();
  });
});

describe("parsePayConfirm / executePayOperation", () => {
  it("executes the stored operation through mock-gateway", async () => {
    const block = buildInteractionButtons([projectionAction()], PRINCIPAL);
    const parsed = parsePayConfirm(block!.buttons[0].value);
    expect(parsed).not.toBeNull();

    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const out = await executePayOperation(
      parsed!.token,
      "http://127.0.0.1:8090/",
      PRINCIPAL,
      fetchMock as unknown as typeof fetch,
    );

    expect(out).toEqual({ ok: true, status: 200, outcome: "succeed" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8090/v1/payment_intents/pi_x/confirm");
    expect(url).not.toContain("manual-confirm");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ outcome: "succeed" });
  });

  it("SECURITY: CSPRNG token bound to minting principal; another user cannot redeem", async () => {
    const alice = { accountId: "acct1", senderId: "alice" };
    const mallory = { accountId: "acct1", senderId: "mallory" };
    const block = buildInteractionButtons([projectionAction()], alice);
    const parsed = parsePayConfirm(block!.buttons[0].value);
    expect(parsed).not.toBeNull();
    // CSPRNG: opaque uuid token, no guessable counter/timestamp.
    expect(parsed!.token).toMatch(
      /^op_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    // principal binding: another user cannot redeem Alice's token.
    await expect(
      executePayOperation(
        parsed!.token,
        "http://gw",
        mallory,
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/not found or expired/);
    expect(fetchMock).not.toHaveBeenCalled();

    // mismatch did not consume the token — the real owner can still redeem.
    const out = await executePayOperation(
      parsed!.token,
      "http://127.0.0.1:8090/",
      alice,
      fetchMock as unknown as typeof fetch,
    );
    expect(out.ok).toBe(true);
  });

  it("rejects non-pay commands and missing tokens", () => {
    expect(parsePayConfirm("/other op_x")).toBeNull();
    expect(parsePayConfirm(`${PAY_CONFIRM_COMMAND}`)).toBeNull();
    expect(parsePayConfirm(`${PAY_CONFIRM_COMMAND} op_x extra`)).toBeNull();
  });
});

describe("confirmPaymentIntent", () => {
  it("POSTs to mock-gateway confirm endpoint with {outcome}, never manual-confirm", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const out = await confirmPaymentIntent(
      "http://127.0.0.1:8090/",
      "pi_x",
      "succeed",
      fetchMock as unknown as typeof fetch,
    );
    expect(out).toEqual({ ok: true, status: 200 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8090/v1/payment_intents/pi_x/confirm");
    expect(url).not.toContain("manual-confirm");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ outcome: "succeed" });
  });

  it("propagates non-2xx as ok=false", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    const out = await confirmPaymentIntent(
      "http://gw",
      "pi_missing",
      "fail",
      fetchMock as unknown as typeof fetch,
    );
    expect(out).toEqual({ ok: false, status: 404 });
  });
});

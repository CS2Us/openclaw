// Shared-fixture parity oracle (TS side) —— core-loop-parity-v1 done_when#2.
//
// This is the *other half* of the dual-end oracle. The Rust integration test
// `crates/chromite-client/tests/parity.rs` reads the same JSON fixtures and
// drives `run_edge_loop`; this suite reads the SAME bytes on disk and drives
// the TS `runEdgeLoop`. A single source of truth (the fixtures/*.json files,
// checked into git) is consumed by both runtimes, so the two ports cannot
// silently drift: changing one fixture re-binds both ends.
//
// The fixtures live in the chromite-client Rust crate (the canonical port
// target). We read them with `fs.readFileSync` (a runtime data read, not a TS
// module import) so the extension package-import boundary is not crossed; only
// the byte oracle is shared. If the path ever moves, both `parity.rs` and this
// file dereference `FIXTURES_DIR` — keep them pointing at the same directory.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runEdgeLoop, type EdgeLoopOptions, type GatewayMessage } from "./chromite-client.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// extensions/chromite-bridge/src → repo-root → src/chromite/crates/chromite-client/fixtures.
// (openclaw/ is nested in the main telegram repo; the fixtures are committed in
// the main repo and read here as a shared data oracle, not imported as code.)
const FIXTURES_DIR = path.resolve(HERE, "../../../../src/chromite/crates/chromite-client/fixtures");

const FIXTURE_NAMES = [
  "text_only_one_turn",
  "single_commerce_tool_roundtrip",
  "fail_soft_401",
  "hit_max_turns",
] as const;

// ===== fixture schema (mirror of parity.rs build_exchanges / build_config) =====

type ReplyKind =
  | { kind: "sse"; status: number; chunks: string[] }
  | { kind: "unary"; status: number; body: string }
  | { kind: "transport_error"; message: string };

type Exchange = {
  match: { method?: string; path: string };
  reply: ReplyKind;
};

type ExpectRequest = {
  path: string;
  headers?: Record<string, string>;
  body?: string;
  body_contains?: string;
  body_roles?: string[];
};

type Fixture = {
  name: string;
  config: {
    base_url: string;
    channel?: string;
    channel_user_id: string;
    max_turns?: number;
  };
  user_msg: string;
  conv_id: string;
  exchanges: Exchange[];
  expect: { reply: string; iterations: number; hit_max_turns: boolean };
  expect_requests?: ExpectRequest[];
};

function loadFixture(name: string): Fixture {
  const raw = readFileSync(path.join(FIXTURES_DIR, `${name}.json`), "utf8");
  return JSON.parse(raw) as Fixture;
}

// ===== fixture-driven fetchImpl (mirror of the Rust FixtureTransport) =====

/** A recorded outbound request (parsed from the fetch() call). */
type SeenRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

function buildSseResponse(chunks: string[], status: number): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Each fixture chunk is fed as a single enqueue, exactly like the Rust
      // FixtureTransport yields one Vec<u8> per chunk. Chunk boundaries are
      // deliberately placed mid-event (straddle) to exercise SSE buffering.
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function buildUnaryResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function headersToRecord(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) {
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) {
      out[k] = v;
    }
  } else if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = v;
    });
  } else {
    for (const [k, v] of Object.entries(h)) {
      out[k] = String(v);
    }
  }
  return out;
}

/**
 * Build a scripted fetch that pops exchanges in order, asserting each request's
 * path against the fixture's `match.path`, and records every request for the
 * `expect_requests` parity assertions. Mirrors `FixtureTransport::pop` + `seen`.
 */
function buildFetchImpl(fixture: Fixture, seen: SeenRequest[]): typeof fetch {
  const queue = [...fixture.exchanges];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    seen.push({
      url,
      method: init?.method ?? "GET",
      headers: headersToRecord(init),
      body: typeof init?.body === "string" ? init.body : "",
    });
    const ex = queue.shift();
    if (!ex) {
      throw new Error(`[${fixture.name}] no scripted reply for ${url}`);
    }
    expect(url, `[${fixture.name}] path for ${url}`).toContain(ex.match.path);
    switch (ex.reply.kind) {
      case "sse":
        return buildSseResponse(ex.reply.chunks, ex.reply.status);
      case "unary":
        return buildUnaryResponse(ex.reply.body, ex.reply.status);
      case "transport_error":
        throw new Error(ex.reply.message);
    }
  };
  return impl as unknown as typeof fetch;
}

function buildOpts(fixture: Fixture, fetchImpl: typeof fetch): EdgeLoopOptions {
  return {
    chromiteUrl: fixture.config.base_url,
    channel: fixture.config.channel ?? "telegram",
    channelUserId: fixture.config.channel_user_id,
    maxTurns: fixture.config.max_turns ?? 8,
    fetchImpl,
  };
}

async function runFixture(name: string): Promise<void> {
  const fixture = loadFixture(name);
  const seen: SeenRequest[] = [];
  const fetchImpl = buildFetchImpl(fixture, seen);
  const opts = buildOpts(fixture, fetchImpl);

  const result = await runEdgeLoop(fixture.user_msg, fixture.conv_id, opts);

  // ===== 1. EdgeLoopResult parity (same oracle the Rust test asserts) =====
  // Fixtures use snake_case `hit_max_turns`; TS surfaces it as `hitMaxTurns`.
  expect(result.reply, `[${name}] reply`).toBe(fixture.expect.reply);
  expect(result.iterations, `[${name}] iterations`).toBe(fixture.expect.iterations);
  expect(result.hitMaxTurns, `[${name}] hit_max_turns`).toBe(fixture.expect.hit_max_turns);

  // ===== 2. recorded-request parity (headers / body / role sequence) =====
  for (const [i, er] of (fixture.expect_requests ?? []).entries()) {
    const req = seen[i];
    expect(req, `[${name}] missing request #${i}`).toBeDefined();
    expect(req.url, `[${name}] req#${i} path`).toContain(er.path);
    if (er.headers) {
      for (const [k, v] of Object.entries(er.headers)) {
        expect(req.headers[k], `[${name}] req#${i} header ${k}`).toBe(v);
      }
    }
    if (typeof er.body === "string") {
      expect(req.body, `[${name}] req#${i} body`).toBe(er.body);
    }
    if (typeof er.body_contains === "string") {
      expect(req.body, `[${name}] req#${i} body_contains`).toContain(er.body_contains);
    }
    if (er.body_roles) {
      const parsed = JSON.parse(req.body) as { messages: GatewayMessage[] };
      const roles = parsed.messages.map((m) => m.role);
      expect(roles, `[${name}] req#${i} message roles`).toEqual(er.body_roles);
    }
  }
}

describe("chromite-client shared-fixture parity oracle (dual-end with parity.rs)", () => {
  it.each(FIXTURE_NAMES)("fixture %s drives runEdgeLoop to the expected result", async (name) => {
    await runFixture(name);
  });
});

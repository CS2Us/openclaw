// Shared-fixture parity oracle (TS side) —— core-loop-parity-v1 done_when#2,
// repurposed for sub-spec 6 (napi-openclaw).
//
// Single source of truth = the Rust `chromite-client` crate. Its integration
// test `crates/chromite-client/tests/parity.rs` reads the JSON fixtures and
// drives `run_edge_loop`; this suite reads the SAME bytes on disk and drives the
// TS `runEdgeLoop` — which now goes through the napi addon into the SAME Rust
// core. There is no longer a duplicate TS loop, so this is an end-to-end napi
// regression: the bridge marshals into Rust, Rust runs the loop over REAL HTTP
// against a loopback server replaying the fixture exchanges, and the terminal
// result must match the fixture oracle.
//
// (Pre-sub-spec-6 this drove a hand-written TS loop via an injected fetchImpl.
// The napi binding has no fetchImpl seam — TLS/HTTP is reqwest inside Rust — so
// the mock fetch is replaced by a loopback HTTP server. Chunk-straddle SSE
// buffering is covered by parity.rs's FixtureTransport; here TCP may coalesce
// chunks, which is fine: we assert the end-to-end result + recorded requests.)
//
// Fixtures live in the main telegram repo (openclaw/ is nested); we read them
// with fs.readFileSync as a shared data oracle, not a code import.

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runEdgeLoop, type EdgeLoopOptions } from "./chromite-client.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// extensions/chromite-bridge/src → repo-root → src/chromite/crates/chromite-client/fixtures.
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

// ===== loopback HTTP server replaying the fixture exchanges (in order) =====

/** A recorded inbound request (Node lowercases header names). */
type SeenRequest = {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

/**
 * Start a loopback server that pops `fixture.exchanges` in arrival order (the
 * Rust loop issues requests sequentially), asserts each request path against the
 * exchange's `match.path`, records the request, and replies per the exchange.
 * Mirrors the Rust `FixtureTransport::pop` + `seen` over real HTTP.
 */
function startFixtureServer(fixture: Fixture, seen: SeenRequest[]): Promise<Server> {
  const queue = [...fixture.exchanges];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k] = Array.isArray(v) ? v.join(",") : String(v ?? "");
      }
      seen.push({
        path: req.url ?? "",
        method: req.method ?? "GET",
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const ex = queue.shift();
      if (!ex) {
        res.statusCode = 500;
        res.end(`[${fixture.name}] no scripted reply for ${req.url}`);
        return;
      }
      expect(req.url ?? "", `[${fixture.name}] path for ${req.url}`).toContain(ex.match.path);
      switch (ex.reply.kind) {
        case "sse":
          res.writeHead(ex.reply.status, { "content-type": "text/event-stream" });
          for (const chunk of ex.reply.chunks) {
            res.write(chunk);
          }
          res.end();
          break;
        case "unary":
          res.writeHead(ex.reply.status, { "content-type": "application/json" });
          res.end(ex.reply.body);
          break;
        case "transport_error":
          req.socket.destroy(); // abrupt close → reqwest transport error
          break;
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/**
 * Derive the authoritative server-tool manifest from the fixture's commerce
 * exchange paths (per EdgeLoopOptions.serverTools doc — parity needs the exact
 * routing set, including fixture-only fake tool names).
 */
function deriveServerTools(fixture: Fixture): string[] {
  const set = new Set<string>();
  for (const ex of fixture.exchanges) {
    const m = ex.match.path.match(/^\/v1\/commerce\/(.+)$/);
    if (m) {
      set.add(m[1]);
    }
  }
  return [...set];
}

let activeServer: Server | undefined;
afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((r) => activeServer!.close(() => r()));
    activeServer = undefined;
  }
});

async function runFixture(name: string): Promise<void> {
  const fixture = loadFixture(name);
  const seen: SeenRequest[] = [];
  const server = await startFixtureServer(fixture, seen);
  activeServer = server;
  const { port } = server.address() as AddressInfo;

  const opts: EdgeLoopOptions = {
    chromiteUrl: `http://127.0.0.1:${port}`,
    channel: fixture.config.channel ?? "telegram",
    channelUserId: fixture.config.channel_user_id,
    maxTurns: fixture.config.max_turns ?? 8,
    serverTools: deriveServerTools(fixture),
  };

  const result = await runEdgeLoop(fixture.user_msg, fixture.conv_id, opts);

  // ===== 1. EdgeLoopResult parity (same oracle parity.rs asserts) =====
  expect(result.reply, `[${name}] reply`).toBe(fixture.expect.reply);
  expect(result.iterations, `[${name}] iterations`).toBe(fixture.expect.iterations);
  expect(result.hitMaxTurns, `[${name}] hit_max_turns`).toBe(fixture.expect.hit_max_turns);

  // ===== 2. recorded-request parity (path / headers / body / role sequence) =====
  // Node lowercases header names; fixtures use canonical case → compare lowercased.
  for (const [i, er] of (fixture.expect_requests ?? []).entries()) {
    const req = seen[i];
    expect(req, `[${name}] missing request #${i}`).toBeDefined();
    expect(req.path, `[${name}] req#${i} path`).toContain(er.path);
    if (er.headers) {
      for (const [k, v] of Object.entries(er.headers)) {
        expect(req.headers[k.toLowerCase()], `[${name}] req#${i} header ${k}`).toBe(v);
      }
    }
    if (typeof er.body === "string") {
      expect(req.body, `[${name}] req#${i} body`).toBe(er.body);
    }
    if (typeof er.body_contains === "string") {
      expect(req.body, `[${name}] req#${i} body_contains`).toContain(er.body_contains);
    }
    if (er.body_roles) {
      const parsed = JSON.parse(req.body) as { messages: Array<{ role: string }> };
      const roles = parsed.messages.map((m) => m.role);
      expect(roles, `[${name}] req#${i} message roles`).toEqual(er.body_roles);
    }
  }
}

describe("chromite-client shared-fixture parity oracle (napi path; dual-end with parity.rs)", () => {
  it.each(FIXTURE_NAMES)(
    "fixture %s drives runEdgeLoop (napi→Rust) to the expected result",
    async (name) => {
      await runFixture(name);
    },
  );
});

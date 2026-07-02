import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Contract guard for the interaction-projection sidechannel across the napi
// boundary. The Rust crate `chromite-client-napi` declares
// `EdgeLoopResultJs.client_actions: Vec<ClientActionJs>`, but the checked-in TS
// binding `@openclaw/chromite-native/index.d.ts` is a hand-maintained copy that
// the bridge compiles against. If that copy is not kept in sync, `readClientActions`
// in chromite-client.ts silently degrades to `[]` and NO interaction buttons ship
// while every unit test stays green (false-green). This parses the binding's own
// type contract — not an operator-policy string — to catch that stale-binding drift.
// See docs/specs/2026-07-01-chromite-interaction-projection-v1.md.
describe("@openclaw/chromite-native binding contract", () => {
  it("exposes clientActions / ClientActionJs on the edge-loop result", () => {
    // Locate the checked-in binding .d.ts the bridge compiles against. Relative
    // resolution (not require.resolve) so it works under vitest's ESM resolver
    // regardless of workspace symlink layout.
    const here = dirname(fileURLToPath(import.meta.url));
    const dts = join(here, "../../../packages/chromite-native/index.d.ts");
    const src = readFileSync(dts, "utf8");

    expect(src).toContain("interface ClientActionJs");
    expect(src).toContain("clientActions");
    // ClientActionJs carries the projection as an opaque JSON string over the boundary.
    expect(src).toMatch(/projection\s*:\s*string/);
  });
});

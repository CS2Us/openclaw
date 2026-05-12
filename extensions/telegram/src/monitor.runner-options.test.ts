// Guard against accidental reintroduction of grammy's internal retry loop.
// History: maxRetryTime used to be 1h, which combined with `silent: true` and
// transport-wrapped errors silently swallowed duplicate-poller / fetch errors
// for hours. The polling session is the single source of truth for retry,
// backoff, fail-fast, and channel-status decisions; grammy must throw on the
// first error so those decisions stay observable.

import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { createTelegramRunnerOptions } from "./monitor.js";

const minimalCfg: OpenClawConfig = {} as OpenClawConfig;

describe("createTelegramRunnerOptions", () => {
  it("disables grammy's internal retry by setting maxRetryTime to 0", () => {
    const opts = createTelegramRunnerOptions(minimalCfg);
    expect(opts.runner?.maxRetryTime).toBe(0);
  });

  it("pins getUpdates timeout to 10s to survive Clash-style proxy idle drops", () => {
    // 30s (grammy default) gets dropped by transparent proxies that idle-kill
    // TCP after 30-60s, causing periodic polling stalls. See monitor.ts for
    // the rationale.
    const opts = createTelegramRunnerOptions(minimalCfg);
    expect(opts.runner?.fetch?.timeout).toBe(10);
  });
});

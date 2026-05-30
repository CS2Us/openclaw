import { describe, expect, it } from "vitest";
import { truncate } from "./format.js";

describe("truncate", () => {
  it("truncates over-long bodies preserving ellipsis", () => {
    expect(truncate("x".repeat(20), 10)).toBe("xxxxxxx...");
  });

  it("leaves short bodies untouched", () => {
    expect(truncate("short", 100)).toBe("short");
  });

  it("returns text unchanged when exactly at the limit", () => {
    expect(truncate("12345", 5)).toBe("12345");
  });
});

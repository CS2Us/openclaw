import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPanelId,
  getPanelId,
  hydratePanelIdsFromStore,
  type PanelIdRecord,
  resetPanelIdStoreForTesting,
  setPanelId,
  setPanelIdStoreForTesting,
} from "./panel-id-store.js";

function createFakeStore(initial: { key: string; value: PanelIdRecord }[] = []) {
  const data = new Map<string, PanelIdRecord>();
  for (const e of initial) data.set(e.key, e.value);
  const calls = {
    register: vi.fn(),
    delete: vi.fn(),
    entries: vi.fn(),
  };
  return {
    data,
    calls,
    store: {
      async register(key: string, value: PanelIdRecord) {
        calls.register(key, value);
        data.set(key, value);
      },
      async delete(key: string) {
        calls.delete(key);
        return data.delete(key);
      },
      async entries() {
        calls.entries();
        return Array.from(data.entries()).map(([key, value]) => ({ key, value }));
      },
    },
  };
}

beforeEach(() => {
  resetPanelIdStoreForTesting();
});

afterEach(() => {
  resetPanelIdStoreForTesting();
});

describe("panel-id-store", () => {
  it("returns undefined when no panel is recorded", () => {
    expect(getPanelId("telegram:5")).toBeUndefined();
  });

  it("hydrates from the persistent store on init", async () => {
    const { store } = createFakeStore([
      {
        key: "telegram:5",
        value: { chatId: "5", messageId: 100, updatedAt: 0 },
      },
    ]);
    setPanelIdStoreForTesting(store);
    await hydratePanelIdsFromStore();
    const r = getPanelId("telegram:5");
    expect(r?.messageId).toBe(100);
  });

  it("setPanelId writes through to the store and is synchronously readable", async () => {
    const { store, data } = createFakeStore();
    setPanelIdStoreForTesting(store);
    setPanelId("telegram:5", { chatId: "5", messageId: 42, updatedAt: 7 });
    expect(getPanelId("telegram:5")?.messageId).toBe(42);
    await new Promise((r) => setTimeout(r, 0)); // let fire-and-forget persist flush
    expect(data.get("telegram:5")?.messageId).toBe(42);
  });

  it("clearPanelId drops both in-memory and persistent state", async () => {
    const { store, data } = createFakeStore([
      { key: "telegram:5", value: { chatId: "5", messageId: 42, updatedAt: 0 } },
    ]);
    setPanelIdStoreForTesting(store);
    await hydratePanelIdsFromStore();
    expect(getPanelId("telegram:5")).toBeDefined();

    clearPanelId("telegram:5");
    expect(getPanelId("telegram:5")).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(data.has("telegram:5")).toBe(false);
  });

  it("works without any store wired (in-memory only)", () => {
    setPanelIdStoreForTesting(null);
    setPanelId("telegram:5", { chatId: "5", messageId: 42, updatedAt: 0 });
    expect(getPanelId("telegram:5")?.messageId).toBe(42);
  });
});

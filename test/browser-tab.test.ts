import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { keepFocused, within } from "../src/browser/tab.js";

describe("within: an answer, or the fallback after a set time", () => {
  test("the answer when it comes in time, the fallback when it fails or is late", async () => {
    expect(await within(Promise.resolve(1), 1000, 0)).toBe(1);
    expect(await within(Promise.reject(new Error("closed")), 1000, 0)).toBe(0);
    expect(await within(new Promise<number>(() => {}), 20, 0)).toBe(0);
  });
  test("the timer is cleared when the answer comes first", async () => {
    const set = globalThis.setTimeout;
    const cleared: unknown[] = [];
    const clear = globalThis.clearTimeout;
    let made: unknown;
    globalThis.setTimeout = ((fn: () => void, ms: number) => (made = set(fn, ms))) as typeof setTimeout;
    globalThis.clearTimeout = ((t: Parameters<typeof clearTimeout>[0]) => {
      cleared.push(t);
      clear(t);
    }) as typeof clearTimeout;
    try {
      expect(await within(Promise.resolve("x"), 60_000, "late")).toBe("x");
    } finally {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
    }
    expect(cleared).toContain(made);
  });
});

describe("keepFocused: one focus emulation per tab", () => {
  function fakePage(fail = false) {
    const state = { sessions: 0, sent: [] as string[] };
    const page = {
      context: () => ({
        newCDPSession: async () => {
          state.sessions++;
          await new Promise((r) => setTimeout(r, 10));
          if (fail) throw new Error("Target closed");
          return { send: async (method: string) => void state.sent.push(method) };
        },
      }),
    } as unknown as Page;
    return { page, state };
  }

  test("calls that come together open one CDP session; later calls open none", async () => {
    const { page, state } = fakePage();
    expect(await Promise.all([keepFocused(page), keepFocused(page), keepFocused(page)])).toEqual([true, true, true]);
    expect(await keepFocused(page)).toBe(true);
    expect(state.sessions).toBe(1);
    expect(state.sent).toEqual(["Emulation.setFocusEmulationEnabled"]);
  });

  test("a tab that refused is asked again on the next call", async () => {
    const { page, state } = fakePage(true);
    expect(await Promise.all([keepFocused(page), keepFocused(page)])).toEqual([false, false]);
    expect(state.sessions).toBe(1);
    expect(await keepFocused(page)).toBe(false);
    expect(state.sessions).toBe(2);
  });
});

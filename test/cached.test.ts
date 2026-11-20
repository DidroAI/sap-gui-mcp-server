import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTest, type SapTest } from "../src/record/format.js";
import { connect, type Drift, runVerified } from "../src/sdk/index.js";
import { FakeSap } from "./record-fakes.js";

/** A verified recording of ZA03 on order 5000, made by a script with a trace. */
async function recorded(): Promise<{ test: SapTest; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cached-"));
  const sap = await connect({ surfaces: [new FakeSap()], trace: { dir, name: "display order" } });
  await sap.okcode("/nZA03");
  await sap.set("ctxtZORD-VBELN", "5000");
  await sap.key(0);
  const { trace } = await sap.close();
  return { test: parseTest(await readFile(trace as string, "utf8")), file: trace as string };
}

describe("runVerified", () => {
  test("the cache holds: no fallback call", async () => {
    const { test: t } = await recorded();
    const sap = await connect({ surfaces: [new FakeSap()] });
    let called = 0;
    const r = await runVerified(sap, t, { fallback: () => (called++, undefined) });
    expect(r.passed).toBe(true);
    expect(r.fallbacks).toBe(0);
    expect(called).toBe(0);
  });

  test("drift: the fallback is called once at the drifting step, its repair is saved", async () => {
    const { file } = await recorded();
    const fake = new FakeSap();
    // SAP now asks a question after Enter that the recording does not have.
    fake.popupsFor.set("5000", [{ title: "Proceed", text: "Display the order anyway?", question: true }]);
    const sap = await connect({ surfaces: [fake] });
    const seen: Drift[] = [];
    const r = await runVerified(sap, file, {
      fallback: (d) => {
        seen.push(d);
        return { why: "SAP asks to confirm before showing the order", actions: [{ do: "press", id: "wnd[1]/usr/btnSPOP-OPTION1" }], place: "after" };
      },
      save: true,
    });
    expect(seen.length).toBe(1);
    expect(seen[0]?.step).toBe(3);
    expect(seen[0]?.screen).toContain("Display the order anyway?");
    expect(r.passed).toBe(true);
    expect(r.saved).toBe(file);
    const saved = parseTest(await readFile(file, "utf8"));
    expect(saved.steps.length).toBe(4);
    expect(saved.steps[3]?.action).toEqual({ do: "press", id: "wnd[1]/usr/btnSPOP-OPTION1" });

    // The next run with the same popup is model-free again.
    const again = new FakeSap();
    again.popupsFor.set("5000", [{ title: "Proceed", text: "Display the order anyway?", question: true }]);
    const sap2 = await connect({ surfaces: [again] });
    const r2 = await runVerified(sap2, file, { fallback: () => { throw new Error("must not be called"); } });
    expect(r2.passed).toBe(true);
    expect(r2.fallbacks).toBe(0);
  });

  test("no fallback, or a fallback that gives up: the run fails at the drifting step", async () => {
    const { test: t } = await recorded();
    const fake = new FakeSap();
    fake.popupsFor.set("5000", [{ title: "Proceed", text: "Display?", question: true }]);
    const sap = await connect({ surfaces: [fake] });
    const r = await runVerified(sap, t, { fallback: () => undefined });
    expect(r.passed).toBe(false);
    expect(r.fallbacks).toBe(1);
    expect(r.repaired).toBeUndefined();
  });
});

/** record/tidy.ts and the tidy export: each rule, the dry replay that verifies it, and the messy run through the runner on two systems. */
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeAction } from "../src/core/action.js";
import { policyFromEnv } from "../src/core/guard.js";
import { type Action, ActionError, type Driver } from "../src/core/types.js";
import { exportSapTs } from "../src/record/export/sap-ts.js";
import { exportTidy, keyName } from "../src/record/export/sap-ts-tidy.js";
import { FORMAT, type SapTest, type Step } from "../src/record/format.js";
import { replay } from "../src/record/replay.js";
import { tidy, verifyTidy } from "../src/record/tidy.js";
import { resolveConfig } from "../src/runner/config.js";
import { runTests } from "../src/runner/run.js";
import { FakeSap } from "./record-fakes.js";
import { messyRun, quirkyFake, recording, unmarkedRun } from "./tidy-fixtures.js";

const RUNNER = resolve(import.meta.dir, "../src/runner/index.ts");
const writes = policyFromEnv({ SAP_WRITE: "on" });

/** A test made of these steps, for the rules that need a precise shape. */
function made(steps: Step[]): SapTest {
  return { format: FORMAT, name: "t", recorded: { at: "2026-11-20T00:00:00Z", surface: "webgui" }, start: { transaction: "SMEN" }, variables: {}, steps };
}
const on = (program: string, screen: string, more: Partial<Step["on"]> = {}) => ({ transaction: "ZA01", program, screen, ...more });

describe("tidy: the messy run", () => {
  test("23 steps become 13, each removal with its reason", async () => {
    const t = await messyRun();
    expect(t.steps.length).toBe(23);
    const r = tidy(t);
    expect(r.test.steps.length).toBe(13);
    expect(r.removed.map((m) => [m.rule, m.steps])).toEqual([
      ["abandoned", [1]],
      ["abandoned", [2, 3, 4]],
      ["error", [7]],
      ["repeat", [8]],
      ["repeat", [10]],
      ["repeat", [11]],
      ["repeat", [21]],
      ["repeat", [22]],
    ]);
    expect(r.origin).toEqual([5, 6, 9, 12, 13, 14, 15, 16, 17, 18, 19, 20, 23]);
    expect(r.log[0]).toBe("23 steps -> 13 (step numbers here are the recording's).");
    expect(r.log).toContain('step 7: dropped (error): {"do":"key","key":0} only raised "E: Fill in all required fields" and stayed on the screen; the steps after it correct the input');
    // The original is not touched.
    expect(t.steps.length).toBe(23);
  });

  test("checks from what SAP showed, variables for typed values, short ids", async () => {
    const r = tidy(await messyRun());
    const s = r.test.steps;
    expect(r.test.variables.quantity?.value).toBe("50");
    expect(r.test.variables.customer?.value).toBe("2200");
    expect(s[1]?.action).toEqual({ do: "set", id: "txtZORD-MENGE", value: "${quantity}" });
    expect(s[2]?.action).toEqual({ do: "set", id: "ctxtZORD-KUNNR", value: "${customer}" });
    // The save's success message, with the captured number.
    expect(s[7]?.expect).toEqual([{ check: "status", op: "contains", value: "Order ${order} has been saved" }]);
    // Landing titles: where the screen changed, not on /n, not into a popup or the availability screen.
    expect(s.flatMap((x, i) => (x.expect ?? []).filter((c) => c.check === "title").map((c) => [i + 1, c.value]))).toEqual([
      [6, "Create Order: Overview"],
      [12, "Display Order ${order}: Overview"],
    ]);
    // Numbered buttons keep their full id.
    expect(s[5]?.action?.id).toBe("wnd[0]/tbar[1]/btn[0]");
    expect(s[11]?.action?.id).toBe("wnd[1]/tbar[0]/btn[0]");
    expect(s[12]?.expect?.map((c) => [c.id, c.value])).toEqual([
      ["ctxtZORD-KUNNR", "${customer}"],
      ["txtZPOS-MENGE[2,0]", "${quantity}"],
    ]);
    expect(r.todo.some((x) => x.includes("availability control"))).toBe(true);
    expect(r.todo.some((x) => x.includes("acceptWarnings"))).toBe(true);
    expect(r.todo.some((x) => x.includes("sap.dismissInfo"))).toBe(true);
  });

  test("the recorder keeps each control's handle, never a numbered one's", async () => {
    const t = await messyRun();
    expect(t.steps[5]?.target).toEqual({ id: "wnd[0]/usr/txtZORD-MENGE", type: "field", label: "Quantity", handle: "txtZORD-MENGE" });
    expect(t.steps[13]?.target?.handle).toBeUndefined();
    expect(t.steps[13]?.target?.id).toBe("wnd[0]/tbar[1]/btn[0]");
    expect(t.steps[22]?.expect?.[0]?.handle).toBe("ctxtZORD-KUNNR");
  });

  test("tidying a tidied test changes nothing", async () => {
    const once = tidy(await messyRun()).test;
    const twice = tidy(once);
    expect(twice.test.steps).toEqual(once.steps);
    expect(twice.removed).toEqual([]);
  });
});

describe("tidy: each rule on its own", () => {
  test("abandoned: a visit with a note, a check or a write stays; so does the last one", () => {
    const go = (t: string, more: Partial<Step> = {}): Step => ({ action: { do: "okcode", value: `/n${t}` }, on: on("P", "1"), after: { transaction: t, program: "P", screen: "1" }, ...more });
    const r = tidy(made([go("ZA03"), go("ZA02", { note: "looked here on purpose" }), go("ZA04", { risk: "commit" }), go("ZA05"), go("ZA01")]));
    expect(r.removed.map((m) => m.steps)).toEqual([[1], [4]]);
    expect(r.test.steps.map((s) => s.action?.value)).toEqual(["/nZA02", "/nZA04", "/nZA01"]);
  });

  test("error: kept at the end of a test (it may be the point), and when it opened a popup", () => {
    const enter = (more: Partial<Step> = {}): Step => ({ action: { do: "key", key: 0 }, on: on("P", "1"), after: { ...on("P", "1"), status: { type: "E", text: "Fill in all required fields" } }, ...more });
    const set: Step = { action: { do: "set", id: "X", value: "1" }, on: on("P", "1"), after: on("P", "1") };
    expect(tidy(made([enter(), set])).removed.map((m) => m.rule)).toEqual(["error"]);
    expect(tidy(made([set, enter()])).removed).toEqual([]);
    expect(tidy(made([enter({ on: on("P", "1", { popup: "wnd[1]" }) }), set])).removed).toEqual([]);
    expect(tidy(made([enter({ expect: [{ check: "status", op: "contains", value: "Fill" }] }), set])).removed).toEqual([]);
  });

  test("repeat: a correction of a field after the error round trip is dropped with it", () => {
    const set = (v: string): Step => ({ action: { do: "set", id: "wnd[0]/usr/ctxtX", value: v }, target: { id: "wnd[0]/usr/ctxtX" }, on: on("P", "1"), after: on("P", "1") });
    const enter: Step = { action: { do: "key", key: 0 }, on: on("P", "1"), after: { ...on("P", "1"), status: { type: "E", text: "Customer 1 does not exist" } } };
    const go: Step = { action: { do: "key", key: 0 }, on: on("P", "1"), after: on("P", "2") };
    const r = tidy(made([set("1"), enter, set("2200"), go]));
    expect(r.removed.map((m) => [m.rule, m.steps])).toEqual([
      ["error", [2]],
      ["repeat", [1]],
    ]);
    expect(r.test.steps.map((s) => s.action?.value ?? s.action?.key)).toEqual(["${x}", 0]);
  });

  test("repeat: a tab is kept when something was done on the tab it showed", () => {
    const tab = (n: string): Step => ({ action: { do: "select", id: `wnd[0]/usr/tabsTS/tabpT\\0${n}` }, target: { id: `wnd[0]/usr/tabsTS/tabpT\\0${n}` }, on: on("P", "3"), after: on("P", "3") });
    const set: Step = { action: { do: "set", id: "wnd[0]/usr/tabsTS/tabpT\\02/ctxtY", value: "a" }, on: on("P", "3"), after: on("P", "3") };
    expect(tidy(made([tab("2"), set, tab("1"), tab("2")])).removed.map((m) => m.steps)).toEqual([[3]]);
    expect(tidy(made([tab("2"), tab("1"), tab("2")])).removed.map((m) => m.steps)).toEqual([[1], [2]]);
  });

  test("capture: a number a status bar gave that later steps use", async () => {
    const r = tidy(await unmarkedRun());
    const save = r.test.steps[4];
    expect(save?.capture).toEqual([{ var: "order", from: "status", pattern: "Order (\\d+)" }]);
    expect(save?.expect).toEqual([{ check: "status", op: "contains", value: "Order ${order} has been saved" }]);
    expect(r.test.steps[6]?.action?.value).toBe("${order}");
    expect(r.todo.some((x) => x.startsWith("The recording marked no check; tidy added 3"))).toBe(true);
  });

  test("status: a number nobody reuses is matched as any number", () => {
    const save: Step = { action: { do: "key", key: 11 }, risk: "commit", on: on("P", "2"), after: { ...on("P", "1"), status: { type: "S", text: "Order 19097 has been saved" } } };
    expect(tidy(made([save])).test.steps[0]?.expect).toEqual([{ check: "status", op: "matches", value: "Order \\d+ has been saved" }]);
  });

  test("variable: a one-character value only replaces the fields typed with it", () => {
    const set: Step = { action: { do: "set", id: "X", value: "2" }, target: { id: "X", label: "Items" }, on: on("P", "1"), after: { ...on("P", "1"), title: "Step 2 of 3" } };
    const r = tidy(made([set]));
    expect(r.test.steps[0]?.action?.value).toBe("${items}");
    expect(r.test.steps[0]?.after?.title).toBe("Step 2 of 3");
  });

  test("key names in code", () => {
    expect([0, 3, 8, 11, 12, 13, 26, 40, 99].map(keyName)).toEqual(["Enter", "Back", "F8", "Control+S", "Escape", "Shift+F1", "Control+F2", "Control+Shift+F4", 99]);
  });
});

describe("verifyTidy", () => {
  test("replays the tidied test and accepts the removals when it passes", async () => {
    const t = await messyRun();
    const v = await verifyTidy(await quirkyFake().open(), t, { policy: writes });
    expect(v.report).toEqual(["run 1: PASS (13 steps; 8 removal(s) accepted)"]);
    expect(v.passed).toBe(true);
    expect(v.reverted).toEqual([]);
  });

  test("puts a removal back when the test fails without it", async () => {
    // A system where creating needs a look at ZA03 first: the visit tidy calls abandoned is needed.
    const fake = new FakeSap();
    let looked = false;
    const base = fake.driver();
    const picky: Driver = Object.assign(Object.create(base) as Driver, {
      act: async (a: Action) => {
        if (a.do === "okcode" && a.value === "/nZA03") looked = true;
        else if (a.do === "okcode" && a.value === "/nZA01") {
          if (!looked) throw new ActionError("ZA01 opens only after ZA03");
          looked = false;
        }
        return base.act(a);
      },
    });
    fake.open = async () => picky;
    const r = await recording("needs a look", fake);
    for (const a of [
      { do: "okcode", value: "/nZA03" },
      { do: "okcode", value: "/nZA01" },
      { do: "set", id: "wnd[0]/usr/ctxtZORD-KUNNR", value: "2200" },
      { do: "key", key: 0 },
    ] as Action[])
      await r.act(normalizeAction(a));
    const t = (await r.recorder.stop()).test;
    expect(tidy(t).removed.map((m) => m.steps)).toEqual([[1]]);
    const v = await verifyTidy(picky, t, { policy: writes });
    expect(v.passed).toBe(true);
    expect(v.reverted.map((m) => m.steps)).toEqual([[1]]);
    expect(v.report[0]).toMatch(/^run 1: FAIL at step 1 \(original step 2\): .*ZA01 opens only after ZA03.*Putting back step 1 \(abandoned\)\.$/);
    expect(v.report[1]).toBe("run 2: PASS (4 steps; 0 removal(s) accepted)");
  });
});

describe("the messy run as code, through the runner", () => {
  /** Writes the code into a project that imports the runner from this checkout, and runs it on `fake`. */
  async function runCode(code: string, fake: FakeSap) {
    const dir = await mkdtemp(join(tmpdir(), "sap-tidy-run-"));
    await writeFile(join(dir, "messy.sap.ts"), code.replace('"sap-ui-automation/test"', JSON.stringify(RUNNER)));
    return runTests({ config: resolveConfig({ use: { write: "on" }, expectTimeout: 300}, dir), surfaces: [fake] });
  }

  test("passes on a system with the quirks and on one without", async () => {
    const t = await messyRun();
    const tidied = exportTidy(t).text;
    const quirky = await runCode(tidied, quirkyFake());
    expect(quirky.tests.map((x) => [x.status, x.error?.message])).toEqual([["passed", undefined]]);
    const plain = await runCode(tidied.replace("messy create", "messy create, plain"), new FakeSap());
    expect(plain.tests.map((x) => [x.status, x.error?.message])).toEqual([["passed", undefined]]);
  });

  test("the step-for-step export and the tidied recording cannot say what the code says", async () => {
    const t = await messyRun();
    // The 1:1 export fails on a system without the availability screen: it presses its Continue unconditionally.
    const raw = await runCode(exportSapTs(t).replace("messy create", "messy create, raw"), new FakeSap());
    expect(raw.tests[0]?.status).toBe("failed");
    // So does a replay of the tidied recording: a step list has no "if".
    const r = await replay(await new FakeSap().open(), writes, tidy(t).test);
    expect(r.passed).toBe(false);
    expect(r.steps.find((s) => s.outcome === "fail")?.failures[0]).toMatch(/landed on another screen/);
  });

  test("the code is shorter and reads as steps", async () => {
    const t = await messyRun();
    const raw = exportSapTs(t);
    const code = exportSapTs(t, { tidy: true });
    expect(code).toContain('await sap.step("Create Order: Initial Screen", async () => {');
    expect(code).toContain('if (await sap.at("SAPLATP4/500")) await sap.button("Continue").press();');
    expect(code).toContain("await sap.save({ acceptWarnings: true });");
    expect(code).toContain("const order = await expect(sap.status()).capture(/Order (\\d+)/);");
    expect(code).toContain("await sap.dismissInfo();");
    expect(code).toContain('await sap.key("Enter");');
    expect(code).not.toContain("wnd[0]/usr/");
    const statements = (s: string) => s.split("\n").filter((l) => /^\s+(await|const|if) /.test(l)).length;
    expect(statements(code)).toBeLessThan(statements(raw));
  });
});

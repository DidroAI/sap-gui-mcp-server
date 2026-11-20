/** Lock files and verified mode (sdk/lock.ts, sdk/verify.ts), and runVerified over code, on the fake SAP. */
import { describe, expect as bunExpect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, Drift, expect, identity, lockPathFor, parseLock, runVerified, type Sap } from "../src/sdk/index.js";
import { FakeSap } from "./record-fakes.js";

const quick = { timeout: 300 };
const tmp = () => mkdtemp(join(tmpdir(), "sap-lock-"));
const lockOf = async (file: string) => parseLock(await readFile(file, "utf8"));
const never = () => {
  throw new Error("the fallback must not be called");
};

/** ZA03: open, display an order, tick the rush box by its full id (a screen that moves its fields breaks it). */
async function display(sap: Sap, p: { order: string }) {
  await sap.step("Open", () => sap.okcode("/nZA03"));
  await sap.step("Display", async () => {
    await sap.set("ctxtZORD-VBELN", p.order);
    await sap.key("Enter");
  });
  await sap.step("Rush", () => sap.check("wnd[0]/usr/subHEAD:SAPMZA03:0301/chkZORD-RUSH"));
  await expect(sap.field("ZORD-KUNNR"), quick).toHaveValue("2200");
}

/** ZA01: create an order; `rush` ticks the box, a branch. */
async function create(sap: Sap, p: { customer: string; quantity: string; rush?: boolean }) {
  await sap.step("Open", () => sap.okcode("/nZA01"));
  await sap.step("Create", async () => {
    await sap.set("ctxtZORD-KUNNR", p.customer);
    await sap.set("txtZORD-MENGE", p.quantity);
    if (p.rush) await sap.check("chkZORD-RUSH");
    await sap.key("Enter");
  });
  await sap.step("Save", () => sap.save());
}

async function session(fake = new FakeSap()) {
  return { fake, sap: await connect({ surfaces: [fake], write: "on", ...quick }) };
}

describe("writing and verifying a lock", () => {
  test("a passing run writes the lock; the next run is verified with no fallback", async () => {
    const dir = await tmp();
    const lock = join(dir, "display.sap.lock.json");
    // With a trace (as the runner runs tests), the lock also holds the screen each action was done on.
    const sap = await connect({ surfaces: [new FakeSap()], write: "on", trace: { dir, name: "display" }, ...quick });
    const r1 = await runVerified(sap, display, { order: "5000" }, { lock, fallback: never });
    bunExpect(r1.passed).toBe(true);
    bunExpect(r1.written).toBe(true);
    bunExpect([r1.verified, r1.unverified]).toEqual([0, 4]);
    const l = await lockOf(lock);
    const entry = l.tests.display;
    bunExpect(l.format).toBe("sap-gui-lock/1");
    bunExpect(entry?.verified).toMatchObject({ system: "ABA", client: "800", surface: "webgui", runs: 1 });
    bunExpect(entry?.steps.map((s) => [s.step, s.ordinal, s.paths.length])).toEqual([
      ["Open", 1, 1],
      ["Display", 1, 1],
      ["Rush", 1, 1],
    ]);
    const enter = entry?.steps[1]?.paths[0]?.[1];
    bunExpect(enter?.action).toEqual({ do: "key", key: "Enter" });
    bunExpect(enter?.after).toMatchObject({ transaction: "ZA03", program: "SAPMZA03", screen: "300" });
    bunExpect(entry?.steps[1]?.paths[0]?.[0]?.on).toMatchObject({ program: "SAPMZA03", screen: "100" });

    const { sap: sap2 } = await session();
    const r2 = await runVerified(sap2, display, { order: "5000" }, { lock, fallback: never });
    bunExpect(r2.passed).toBe(true);
    bunExpect([r2.verified, r2.unverified, r2.fallbacks]).toEqual([4, 0, 0]);
    bunExpect((await lockOf(lock)).tests.display?.verified.runs).toBe(2);
  });

  test("connect({ verify }) checks each action; the availability screen appearing throws Drift at its action", async () => {
    const dir = await tmp();
    const lock = join(dir, "create.sap.lock.json");
    const first = await connect({ surfaces: [new FakeSap()], write: "on", verify: { lock, key: "create" }, ...quick });
    await create(first, { customer: "2200", quantity: "50" });
    await first.lock?.finish(true);

    const fake = new FakeSap();
    fake.available = 10;
    const sap = await connect({ surfaces: [fake], write: "on", verify: { lock, key: "create" }, ...quick });
    const e = await create(sap, { customer: "2200", quantity: "50" }).catch((x: unknown) => x);
    bunExpect(e).toBeInstanceOf(Drift);
    const d = e as Drift;
    bunExpect([d.step, d.ordinal, d.actionIndex, d.phase]).toEqual(["Create", 1, 2, "landing"]);
    bunExpect(d.expected.after.program).toBe("SAPMZA01");
    bunExpect(d.actual.after).toMatchObject({ program: "SAPLATP4", screen: "500" });
    bunExpect(d.screen).toContain("Availability Control");
    bunExpect(d.code).toBe('await sap.key("Enter");');
    bunExpect(d.site).toContain("lock.test.ts:");
    bunExpect(d.message).toContain('Drift in step "Create", action 3 (await sap.key("Enter");');
    bunExpect(d.message).toContain("--update-locks");
    bunExpect(JSON.parse(JSON.stringify(d))).toMatchObject({ step: "Create", phase: "landing", lock });
    // Nothing was saved: the code stopped at the drift.
    bunExpect(fake.orders.size).toBe(1);
  });

  test("a new error in the status bar is drift of phase check", async () => {
    const dir = await tmp();
    const lock = join(dir, "x.lock.json");
    const { sap } = await session();
    const fn = async (s: Sap) => s.step("Display", async () => {
      await s.okcode("/nZA03");
      await s.set("ctxtZORD-VBELN", "5000");
      await s.key("Enter");
    });
    bunExpect((await runVerified(sap, fn, {}, { lock })).passed).toBe(true);
    // The same screen, with an error SAP did not show when the lock was written.
    class Blocked extends FakeSap {
      override view(): string {
        return `${super.view()}${this.transaction === "ZA03" && this.screen === "300" ? "\nwnd[0]/sbar  status  E: Order 5000 is blocked" : ""}`;
      }
    }
    const r = await runVerified((await session(new Blocked())).sap, fn, {}, { lock });
    bunExpect(r.passed).toBe(false);
    bunExpect(r.drift?.phase).toBe("check");
    bunExpect(r.drift?.actual.status).toEqual({ type: "E", text: "Order 5000 is blocked" });
    bunExpect(r.drift?.message).toContain("SAP answered with E: Order 5000 is blocked");
    bunExpect(r.written).toBe(false);
    // An order that does not exist: ZA03 stays on its first screen, so the landing differs first.
    const fake = new FakeSap();
    fake.orders.delete("5000");
    const r2 = await runVerified((await session(fake)).sap, fn, {}, { lock });
    bunExpect(r2.drift?.phase).toBe("landing");
    bunExpect(r2.drift?.actual.status).toEqual({ type: "E", text: "Order 5000 does not exist" });
  });
});

describe("drift, fallback and overlays", () => {
  test("an extra popup: the fallback's repair runs inside the action, is saved as an overlay, and the next run needs no model", async () => {
    const dir = await tmp();
    const lock = join(dir, "display.sap.lock.json");
    await runVerified((await session()).sap, display, { order: "5000" }, { lock });

    const popup = () => {
      const f = new FakeSap();
      f.popupsFor.set("5000", [{ title: "Proceed", text: "Display the order anyway?", question: true }]);
      return f;
    };
    const seen: Drift[] = [];
    const r = await runVerified((await session(popup())).sap, display, { order: "5000" }, {
      lock,
      fallback: (d) => {
        seen.push(d);
        return { why: "SAP asks before it shows the order", place: "after", actions: [{ do: "press", id: "wnd[1]/usr/btnSPOP-OPTION1" }] };
      },
    });
    bunExpect(r.passed).toBe(true);
    bunExpect(seen.length).toBe(1);
    bunExpect([seen[0]?.step, seen[0]?.actionIndex, seen[0]?.phase]).toEqual(["Display", 1, "landing"]);
    bunExpect(seen[0]?.screen).toContain("Display the order anyway?");
    bunExpect(r.fallbacks).toBe(1);
    bunExpect(r.repairs).toEqual([{ step: "Display", ordinal: 1, actionIndex: 1, place: "after", why: "SAP asks before it shows the order", by: "fallback", did: ['{"do":"press","id":"wnd[1]/usr/btnSPOP-OPTION1"}'] }]);
    bunExpect(r.patches[0]).toContain('In step "Display", after action 2 (await sap.key("Enter");');
    bunExpect(r.patches[0]).toContain('await sap.press("wnd[1]/usr/btnSPOP-OPTION1");');
    const step = (await lockOf(lock)).tests.display?.steps.find((s) => s.step === "Display");
    bunExpect(step?.repairs).toMatchObject([{ index: 1, on: identity({ do: "key", key: "Enter" }), place: "after", actions: [{ do: "press", id: "wnd[1]/usr/btnSPOP-OPTION1" }] }]);
    // The run's own path is the lock's: the overlay is not a new path.
    bunExpect(step?.paths.length).toBe(1);

    // The same popup: the overlay answers it; the fallback is never asked.
    const again = await runVerified((await session(popup())).sap, display, { order: "5000" }, { lock, fallback: never });
    bunExpect(again.passed).toBe(true);
    bunExpect(again.fallbacks).toBe(0);
    bunExpect(again.repairs.map((x) => x.by)).toEqual(["lock"]);
    // No popup: the overlay is not needed and not applied.
    const plain = await runVerified((await session()).sap, display, { order: "5000" }, { lock, fallback: never });
    bunExpect(plain.passed).toBe(true);
    bunExpect(plain.repairs).toEqual([]);
  });

  test("a control that moved: act-phase drift, an 'instead' repair, applied from the lock next time", async () => {
    const dir = await tmp();
    const lock = join(dir, "display.sap.lock.json");
    await runVerified((await session()).sap, display, { order: "5000" }, { lock });
    const moved = () => {
      const f = new FakeSap();
      f.moved = true;
      return f;
    };
    const r = await runVerified((await session(moved())).sap, display, { order: "5000" }, {
      lock,
      fallback: (d) => {
        bunExpect([d.step, d.phase]).toEqual(["Rush", "act"]);
        return { why: "the header moved into another subscreen", place: "instead", actions: [{ do: "check", id: "wnd[0]/usr/subNEW:SAPMZA03:0310/chkZORD-RUSH", value: true }] };
      },
    });
    bunExpect(r.passed).toBe(true);
    bunExpect(r.patches[0]).toContain('replace action 1 (await sap.check("wnd[0]/usr/subHEAD:SAPMZA03:0301/chkZORD-RUSH");');
    const again = await runVerified((await session(moved())).sap, display, { order: "5000" }, { lock, fallback: never });
    bunExpect(again.passed).toBe(true);
    bunExpect(again.repairs.map((x) => [x.by, x.place])).toEqual([["lock", "instead"]]);
  });

  test("a repair that adds a write is refused, and the run fails with the Drift", async () => {
    const dir = await tmp();
    const lock = join(dir, "display.sap.lock.json");
    await runVerified((await session()).sap, display, { order: "5000" }, { lock });
    const fake = new FakeSap();
    fake.popupsFor.set("5000", [{ title: "Proceed", text: "Display?", question: true }]);
    let calls = 0;
    const r = await runVerified((await session(fake)).sap, display, { order: "5000" }, {
      lock,
      fallback: () => (calls++, { why: "save it", place: "after", actions: [{ do: "key", key: 11 }] }),
    });
    bunExpect(r.passed).toBe(false);
    bunExpect(calls).toBe(2);
    bunExpect(r.drift?.tried.join("\n")).toContain("a repair adds no write");
    bunExpect(r.error?.message).toContain("Tried: repair \"save it\": refused:");
    bunExpect(fake.acts.some((a) => a.do === "key" && (a.key === 11 || a.key === "11"))).toBe(false);
    bunExpect((await lockOf(lock)).tests.display?.steps[1]?.repairs).toBeUndefined();
  });

  test("an invented value and a wrong place are refused", async () => {
    const dir = await tmp();
    const lock = join(dir, "display.sap.lock.json");
    await runVerified((await session()).sap, display, { order: "5000" }, { lock });
    const fake = new FakeSap();
    fake.moved = true;
    const answers = [
      { why: "x", place: "after" as const, actions: [{ do: "check", id: "chkZORD-RUSH" }] },
      { why: "y", place: "before" as const, actions: [{ do: "set", id: "ctxtZORD-VBELN", value: "777777" }] },
    ];
    const r = await runVerified((await session(fake)).sap, display, { order: "5000" }, { lock, fallback: () => answers.shift() });
    bunExpect(r.passed).toBe(false);
    bunExpect(r.drift?.tried[0]).toContain('the action did not run: a repair is "before"');
    bunExpect(r.drift?.tried[1]).toContain('"777777" is neither in the recording nor on the screen');
  });
});

describe("branches and modes", () => {
  test("a branch the lock has not seen is unverified, then recorded as a second path", async () => {
    const dir = await tmp();
    const lock = join(dir, "create.sap.lock.json");
    const plain = await runVerified((await session()).sap, create, { customer: "2200", quantity: "3" }, { lock, key: "create" });
    bunExpect(plain.passed).toBe(true);
    const rush = await runVerified((await session()).sap, create, { customer: "2200", quantity: "3", rush: true }, { lock, key: "create", fallback: never });
    bunExpect(rush.passed).toBe(true);
    // The check and the Enter after it: the lock had no path with a check there.
    bunExpect(rush.unverified).toBe(2);
    const paths = (await lockOf(lock)).tests.create?.steps.find((s) => s.step === "Create")?.paths;
    bunExpect(paths?.map((p) => p.map((a) => a.action.do))).toEqual([
      ["set", "set", "key"],
      ["set", "set", "check", "key"],
    ]);
    const again = await runVerified((await session()).sap, create, { customer: "2200", quantity: "3", rush: true }, { lock, key: "create", fallback: never });
    bunExpect([again.passed, again.unverified]).toEqual([true, 0]);
    const back = await runVerified((await session()).sap, create, { customer: "2200", quantity: "3" }, { lock, key: "create", fallback: never });
    bunExpect([back.passed, back.unverified]).toEqual([true, 0]);
  });

  test("write mode compares nothing and adds the new screens; a failing run writes nothing", async () => {
    const dir = await tmp();
    const lock = join(dir, "create.sap.lock.json");
    await runVerified((await session()).sap, create, { customer: "2200", quantity: "50" }, { lock, key: "create" });
    const fake = new FakeSap();
    fake.available = 10;
    // The code does not handle the availability screen: it fails in write mode too, and writes nothing.
    const failed = await runVerified((await session(fake)).sap, create, { customer: "2200", quantity: "50" }, { lock, key: "create", mode: "write" });
    bunExpect(failed.passed).toBe(false);
    bunExpect(failed.drift).toBeUndefined();
    bunExpect(failed.written).toBe(false);
    const handles = async (sap: Sap) => {
      await sap.step("Open", () => sap.okcode("/nZA01"));
      await sap.step("Create", async () => {
        await sap.set("ctxtZORD-KUNNR", "2200");
        await sap.set("txtZORD-MENGE", "50");
        await sap.key("Enter");
        if (await sap.at("SAPLATP4/0500")) await sap.button("Continue").press();
      });
      await sap.step("Save", () => sap.save());
    };
    const fake2 = new FakeSap();
    fake2.available = 10;
    const w = await runVerified((await session(fake2)).sap, handles, {}, { lock, key: "create", mode: "write" });
    bunExpect([w.passed, w.written]).toEqual([true, true]);
    const fake3 = new FakeSap();
    fake3.available = 10;
    const v = await runVerified((await session(fake3)).sap, handles, {}, { lock, key: "create", fallback: never });
    bunExpect([v.passed, v.verified, v.unverified]).toEqual([true, 6, 0]);
  });

  test("a module export runs with its lock next to it; a lock of another system is not used", async () => {
    const dir = await tmp();
    const file = join(dir, "flow.sap.ts");
    const SDK = JSON.stringify(join(import.meta.dir, "../src/sdk/index.ts"));
    await Bun.write(file, `import type { Sap } from ${SDK};\nexport async function show(sap: Sap, p: { order: string }) {\n  await sap.okcode("/nZA03");\n  await sap.set("ctxtZORD-VBELN", p.order);\n  await sap.key("Enter");\n}\n`);
    const r = await runVerified((await session()).sap, { file, export: "show" }, { order: "5000" });
    bunExpect(r.passed).toBe(true);
    bunExpect(r.lock).toBe(lockPathFor(file));
    bunExpect(r.lock).toBe(join(dir, "flow.sap.lock.json"));
    bunExpect(Object.keys((await lockOf(r.lock)).tests)).toEqual(["show"]);
    const other = await runVerified((await session(new FakeSap("webgui", "XYZ"))).sap, { file, export: "show" }, { order: "5000" }, { fallback: never });
    bunExpect(other.passed).toBe(true);
    bunExpect(other.written).toBe(false);
    bunExpect(other.notes[0]).toContain("verified on system ABA");
  });
});

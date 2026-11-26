import { describe, expect as bunExpect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTest } from "../src/record/format.js";
import { bareLabel, callOf, codeOf, connect, draftTest, expect, ExpectError, parseGrid, Refused } from "../src/sdk/index.js";
import { FakeSap } from "./record-fakes.js";

const quick = { timeout: 300 };

describe("connect", () => {
  test("attaches to the session of the system asked for", async () => {
    const fake = new FakeSap("webgui", "ABA");
    const sap = await connect({ surfaces: [fake], system: "ABA" });
    bunExpect(sap.info.system).toBe("ABA");
    await sap.close();
  });
  test("says what is open when nothing fits", async () => {
    const fake = new FakeSap("webgui", "ABA");
    await bunExpect(connect({ surfaces: [fake], system: "PRD" })).rejects.toThrow(/No open SAP session with system PRD\. Open now: webgui ABA\/800/);
  });
});

describe("acting and asserting", () => {
  test("a display flow with web-first assertions", async () => {
    const sap = await connect({ surfaces: [new FakeSap()], ...quick });
    await sap.okcode("/nZA03");
    await sap.set("ctxtZORD-VBELN", "5000");
    await sap.key(0);
    await expect(sap).toHaveTransaction("ZA03");
    await expect(sap).toHaveTitle(/Display Order 5000/);
    await expect(sap.field("ZORD-KUNNR")).toHaveValue("2200");
    await expect(sap.field("ZORD-KUNNR")).toBeReadOnly();
    await expect(sap.field("ZORD-KUNNR")).not.toBeEditable();
    await expect(sap.field("ZORD-RUSH")).toBeChecked();
    await expect(sap.field("NOPE-X")).not.toBeVisible();
    bunExpect(await sap.field("ctxtZORD-VBELN").value()).toBe("5000");
    bunExpect(sap.code()).toEqual(['await sap.okcode("/nZA03");', 'await sap.set("ctxtZORD-VBELN", "5000");', "await sap.key(0);"]);
    bunExpect(sap.history.every((h) => h.ms >= 0)).toBe(true);
    await sap.close();
  });
  test("a failing assertion says what is there, after waiting", async () => {
    const sap = await connect({ surfaces: [new FakeSap()], timeout: 250 });
    await sap.okcode("/nZA03");
    await sap.set("ctxtZORD-VBELN", "9999");
    await sap.key(0);
    await expect(sap.status()).toBeError();
    const t0 = Date.now();
    const e = await expect(sap.status()).toBeSuccess().catch((x: Error) => x);
    bunExpect(e).toBeInstanceOf(ExpectError);
    bunExpect((e as Error).message).toContain('the status bar is E: "Order 9999 does not exist"');
    bunExpect(Date.now() - t0).toBeGreaterThanOrEqual(240);
  });
  test("the guard applies to scripts: a save is refused with writes off", async () => {
    const fake = new FakeSap();
    const sap = await connect({ surfaces: [fake], write: "off" });
    await sap.okcode("/nZA01");
    await sap.set("ctxtZORD-KUNNR", "2200");
    await sap.key(0);
    await bunExpect(sap.key(11)).rejects.toBeInstanceOf(Refused);
    bunExpect(fake.orders.size).toBe(1);
  });
  test("write confirm asks onConfirm; no callback is no", async () => {
    const asked: string[] = [];
    const fake = new FakeSap();
    const sap = await connect({ surfaces: [fake], write: "confirm", onConfirm: ({ reason }) => (asked.push(reason), true) });
    await sap.okcode("/nZA01");
    await sap.set("ctxtZORD-KUNNR", "2200");
    await sap.key(0);
    await sap.key(11);
    bunExpect(asked).toEqual(["key 11: Save"]);
    await expect(sap.status()).toContainText("has been saved");
    const other = await connect({ surfaces: [new FakeSap()], write: "confirm" });
    await other.okcode("/nZA01");
    await other.set("ctxtZORD-KUNNR", "1");
    await other.key(0);
    await bunExpect(other.key(11)).rejects.toThrow(/needs an onConfirm/);
  });
  test("by default (no write, SAP_WRITE unset) a script is in confirm: without onConfirm a save is refused", async () => {
    const fake = new FakeSap();
    const sap = await connect({ surfaces: [fake], env: {} });
    await sap.okcode("/nZA01");
    await sap.set("ctxtZORD-KUNNR", "2200");
    await sap.key(0);
    await bunExpect(sap.key(11)).rejects.toThrow(/write is "confirm", the default: a script needs an onConfirm callback.*write: "on"/);
    bunExpect(fake.orders.size).toBe(1);
  });
  test("blocked transactions are refused", async () => {
    const sap = await connect({ surfaces: [new FakeSap()], blockTcodes: ["ZA01"] });
    await bunExpect(sap.okcode("/nZA01")).rejects.toThrow(/blocked/);
  });
  test("a trace records steps with timings, screens and SDK lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sdk-trace-"));
    const sap = await connect({ surfaces: [new FakeSap()], trace: { dir, name: "trace one", screenshots: true } });
    await sap.okcode("/nZA03");
    await sap.set("ctxtZORD-VBELN", "5000");
    const { trace } = await sap.close();
    bunExpect(trace).toBe(join(dir, "trace-one.saptest.json"));
    const t = parseTest(await readFile(trace as string, "utf8"));
    bunExpect(t.steps.length).toBe(2);
    bunExpect(t.steps[0]?.code).toBe('await sap.okcode("/nZA03");');
    bunExpect(typeof t.steps[0]?.ms).toBe("number");
    bunExpect(t.steps[1]?.screen).toContain("ZORD-VBELN");
    bunExpect(t.steps[1]?.shot).toBe("trace-one.trace/step-2.png");
    bunExpect(await readFile(join(dir, "trace-one.trace/step-2.png"), "utf8")).toBe("png");
  });
});

describe("code lines", () => {
  test("one line per action, shorthand where there is one", () => {
    bunExpect(codeOf({ do: "okcode", value: "/nVA03" })).toBe('await sap.okcode("/nVA03");');
    bunExpect(codeOf({ do: "set", id: "ctxtVBAK-VBELN", value: "4711" })).toBe('await sap.set("ctxtVBAK-VBELN", "4711");');
    bunExpect(codeOf({ do: "set", id: "grid", row: 0, col: "X", value: "1" })).toBe('await sap.set("grid", "1", {"row":0,"col":"X"});');
    bunExpect(codeOf({ do: "check", id: "c", value: false })).toBe('await sap.check("c", false);');
    bunExpect(codeOf({ do: "check", id: "c", value: true })).toBe('await sap.check("c");');
    bunExpect(callOf({ do: "grid", id: "g", row: 1, col: "VBELN", how: "double" })).toBe('sap.act({"do":"grid","id":"g","row":1,"col":"VBELN","how":"double"})');
    bunExpect(codeOf({ do: "key", key: "Enter" })).toBe('await sap.key("Enter");');
  });
  test("a draft is a test file", () => {
    bunExpect(draftTest({ name: "va03", lines: ['await sap.okcode("/nVA03");'] })).toBe(
      'import { expect, test } from "sap-ui-automation/test";\n\ntest("va03", async ({ sap }) => {\n  await sap.okcode("/nVA03");\n});\n',
    );
  });
});

describe("grids", () => {
  test("parses a grid's rows and cells", () => {
    const g = parseGrid("wnd[0]/usr/cntlGRID1/shellcont/shell  grid  52 rows; columns: VBELN=Sales Doc. | NETWR=Net value\n  row 0: 4700 | 100.00\n  row 1: 4701 | 200.00", "g");
    bunExpect(g.columns).toEqual(["VBELN", "NETWR"]);
    bunExpect(g.titles).toEqual(["Sales Doc.", "Net value"]);
    bunExpect(g.total).toBe(52);
    bunExpect(g.rows[1]?.cells).toEqual(["4701", "200.00"]);
  });
});

describe("table controls", () => {
  test("parses the compact table control format into aligned cells", () => {
    const text = [
      "tblSAPMV45ATCTRL_U_ERF_AUFTRAG  table  rows 3 (visible 3)  (cell id: <id>[col,row], e.g. txtVBAP-POSNR[0,0])",
      "  columns: 0 Item=txtVBAP-POSNR (read-only), 1 Material=ctxtRV45A-MABNR (read-only), 2 Order Quantity=txtRV45A-KWMENG (read-only), 3 Rej=chkVBAP-ABGRU",
      "  row 0: Item=10; Material=M-01; Order Quantity=5; Rej [ ]",
      "  row 1: Item=20; Material=M-02; Order Quantity=1; Rej [x]",
      "  row 2: Rej [ ]",
    ].join("\n");
    const g = parseGrid(text, "tbl");
    bunExpect(g.titles).toEqual(["Item", "Material", "Order Quantity", "Rej"]);
    bunExpect(g.columns).toEqual(["VBAP-POSNR", "RV45A-MABNR", "RV45A-KWMENG", "VBAP-ABGRU"]);
    bunExpect(g.total).toBe(3);
    bunExpect(g.rows[0]?.cells).toEqual(["10", "M-01", "5", "false"]);
    bunExpect(g.rows[1]?.cells).toEqual(["20", "M-02", "1", "true"]);
    bunExpect(g.rows[2]?.cells).toEqual(["", "", "", "false"]);
  });

  test("a legend with columns scrolled out, and two columns with one title (VA03 items on ECC Web GUI)", () => {
    const text = [
      'tblSAPMV45ATCTRL_U_ERF_AUFTRAG  table  rows 9 (visible 9) "All items"; rows can be selected  (cell id: <id>[col,row], e.g. txtVBAP-POSNR[0,0])',
      '  columns: 0 Item=txtVBAP-POSNR (read-only), 1 Material=ctxtRV45A-MABNR (read-only), 4 Description=txtVBAP-ARKTX (read-only), 5 S=chkVBAPD-EPMEH (read-only), 67 Description=txtTPRIT-BEZEI; 41 more to the right (scroll "to":"right"): Ship./Receiving Pnt, Route, ...',
      "  row 0: Item=10; Material=P-109; Description [col 4]=Pumpe Stahlguss; S [x]; Description [col 67]=Standard item",
    ].join("\n");
    const g = parseGrid(text, "tbl");
    bunExpect(g.columns).toEqual(["VBAP-POSNR", "RV45A-MABNR", "VBAP-ARKTX", "VBAPD-EPMEH", "TPRIT-BEZEI"]);
    bunExpect(g.rows[0]?.cells).toEqual(["10", "P-109", "Pumpe Stahlguss", "true", "Standard item"]);
  });

  test("long adversarial lines are read in linear time", () => {
    const t0 = performance.now();
    parseGrid(`g  grid  ${"9".repeat(50_000)}; columns: ${"columns: a".repeat(20_000)}`, "g");
    const legend = `  columns: ${"; 9 more to the left (".repeat(20_000)}\r`;
    parseGrid(`tbl  table  rows 1\n${legend}\n  row 0: ${"=a".repeat(50_000)}\r`, "tbl");
    bunExpect(bareLabel(`${" ".repeat(50_000)}x`)).toBe("x");
    bunExpect(bareLabel("Continue (Enter) ")).toBe("Continue");
    bunExpect(performance.now() - t0).toBeLessThan(200);
  });
});

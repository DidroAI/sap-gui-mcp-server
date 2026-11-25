import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { diffViews } from "../src/core/diff.js";
import { legendsOf, Views } from "../src/core/views.js";

const legend = `columns: ${Array.from({ length: 20 }, (_, i) => `${i} Column ${i}=txtVBAP-F${i}`).join(", ")}`;
const screen = (block: string) =>
  [
    "TRANSACTION VA02  PROGRAM SAPMV45A  SCREEN 4001",
    'WINDOW wnd[0]  "Change Returns 60000226: Overview"',
    ...Array.from({ length: 30 }, (_, i) => `txtF${i}  field  Field ${i} = "${i}"  (read-only)`),
    `cmbVBAK-FAKSK  dropdown  Billing block = "${block}"  (14 options)`,
    "tblSAPMV45ATCTRL_U_ERF_AUFTRAG  table  rows 3 (visible 2)  (cell id: <id>[col,row], e.g. txtVBAP-POSNR[0,0])",
    `  ${legend}`,
    "  row 0: Item=10; Material=M-17",
  ].join("\n");

describe("a table's columns said once do not make the next answer whole (VA02, live 2026-11-25)", () => {
  // Two answers of a live run: after the popup (the table's legend in full), then after the billing block was cleared.
  const before = readFileSync(new URL("./fixtures/views/va02-before.txt", import.meta.url), "utf8");
  const after = readFileSync(new URL("./fixtures/views/va02-after.txt", import.meta.url), "utf8");
  test("live: the diff is the one changed line, not the old legend as removed", () => {
    expect(diffViews(before, after).text.length).toBeGreaterThan(after.length * 0.6);
    const d = diffViews(before, legendsOf(before, after)).text;
    expect(d.split("\n")).toHaveLength(2);
    expect(d).toContain('~ cmbVBAK-FAKSK  dropdown  Billing block = ""');
  });
  test("only the changed dropdown is in the answer, not the old legend as removed", () => {
    const views = new Views("diff");
    const first = views.present("s", screen("08"));
    expect(first).toContain(legend);
    const next = views.present("s", screen(""));
    expect(next).toStartWith("CHANGED");
    expect(next).toContain('~ cmbVBAK-FAKSK  dropdown  Billing block = ""');
    expect(next).not.toContain("Column 7");
    expect(next.length).toBeLessThan(400);
  });
  test("legendsOf puts back the legend and a grid's inline columns of the same control", () => {
    const cols = Array.from({ length: 20 }, (_, i) => `C${i}=Title ${i}`).join(" | ");
    const prev = `grd  grid  3 rows; columns: ${cols}\ntbl  table  rows 1\n  ${legend}`;
    const view = "grd  grid  4 rows; columns: as listed before\ntbl  table  rows 1\n  columns: as listed before";
    expect(legendsOf(prev, view)).toBe(`grd  grid  4 rows; columns: ${cols}\ntbl  table  rows 1\n  ${legend}`);
  });
});

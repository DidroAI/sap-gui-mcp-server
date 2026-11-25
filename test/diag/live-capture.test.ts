/**
 * Screens cut from a capture of SAP GUI for Windows against an ECC system
 * (SAP_DIAG_CAPTURE, 25 November 2026). Each fixture holds only the frames
 * of the steps it tests: SAP's messages, and for the MMBE tree SAP GUI's
 * answers too. None holds the logon. Format: per chunk, the direction (1
 * byte), the time (float64), the length (uint32 little-endian), the bytes.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DiagDecoder } from "../../src/diag/decoder.js";
import type { DiagScreen } from "../../src/diag/screen.js";
import { diagView } from "../../src/diag/view.js";
import type { Geometry } from "../../src/sapgui-diag/plan.js";
import { planTree } from "../../src/sapgui-diag/plan.js";
import { findTarget } from "../../src/sapgui-diag/index.js";

function replay(name: string): DiagScreen[] {
  const buf = readFileSync(join(import.meta.dir, "../fixtures/diag", name));
  const d = new DiagDecoder();
  const screens: DiagScreen[] = [];
  d.onScreen = (s) => screens.push(s);
  for (let off = 0; off < buf.length; ) {
    const dir = buf[off] as 0 | 1;
    const len = buf.readUInt32LE(off + 9);
    d.push(dir, buf.subarray(off + 13, off + 13 + len));
    off += 13 + len;
  }
  return screens;
}

const cell = (s: DiagScreen, table: string, index: number, column: string): string | undefined => {
  const t = s.windows[0]?.tables.find((x) => x.name === table);
  const c = t?.columns.find((x) => x.name === column);
  return t?.rows.find((r) => r.index === index)?.cells[c?.index ?? -1]?.text;
};

describe("table controls from a live capture", () => {
  test("VA03: every item row reads right, also those that reuse the cell description of the row before", () => {
    const [s] = replay("va03-items.bin");
    expect(s?.unread ?? []).toEqual([]);
    expect([0, 1].map((i) => ["VBAP-POSNR", "RV45A-MABNR", "RV45A-KWMENG", "VBAP-NETWR"].map((c) => cell(s as DiagScreen, "TCTRL_U_ERF_AUFTRAG", i, c)))).toEqual([
      ["10", "P-109", "500", "2.750.000,00"],
      ["20", "P-103", "20", "130.000,00"],
    ]);
    const t = s?.windows[0]?.tables[0];
    expect(t?.rows.map((r) => [r.index, r.row, r.empty])).toEqual([
      [0, 17, false],
      [1, 18, false],
      [2, 19, true],
      [3, 20, true],
    ]);
    expect(t).toMatchObject({ totalRows: 2, visibleRows: 4 });
    // The empty entry lines are hidden templates ("______"): never shown as values.
    const v = diagView(s as DiagScreen);
    expect(v).not.toContain("___");
    // The head lists the columns that hold something in the rows on show, not all 109.
    expect(v).toContain("Item VBAP-POSNR | Material RV45A-MABNR");
    expect(v).not.toContain("Batch VBAP-CHARG");
    expect(v).toMatch(/109 columns: .* \| \(\d+ more, empty and read-only in the rows on show\)/);
  });

  test("VA02 scrolled to its second item: the first line on show is item 20, line 1 of the table", () => {
    const [s] = replay("va02-scrolled.bin");
    const t = s?.windows[0]?.tables[0];
    expect(t?.rows[0]).toMatchObject({ index: 1, row: 17 });
    expect(cell(s as DiagScreen, "TCTRL_U_ERF_AUFTRAG", 1, "RV45A-MABNR")).toBe("P-103");
  });

  test("ME23N: a table with no title, a push button in each row, a dropdown with a function code", () => {
    const [s] = replay("me23n-items.bin");
    expect((s?.unread ?? []).filter((u) => u.includes("TC_1211"))).toEqual([]);
    const t = s?.windows[0]?.tables.find((x) => x.name === "TC_1211");
    expect(t?.title).toBe("");
    expect(t?.columns.find((c) => c.name === "MEPO1211-EBELP")?.title).toBe("Itm");
    expect(["MEPO1211-EBELP", "MEPO1211-EMATN", "MEPO1211-TXZ01", "MEPO1211-MENGE", "MEPO1211-MEINS"].map((c) => cell(s as DiagScreen, "TC_1211", 0, c))).toEqual(["10", "100-100", "Casings", "5", "PC"]);
    expect(t?.rows[0]?.cells[0]).toMatchObject({ kind: "button", fcode: "MEPO1211MSG" });
    // A button's or a tab's function code is taken without its braces, as agents write it.
    for (const [id, what] of [["MEV4000BUTTON", 'button "Collapse Header Ctrl+F5"'], ["{MEV4000BUTTON}", 'button "Collapse Header Ctrl+F5"'], ["TABHDT10", 'tab "Org. Data"']] as const) {
      const f = findTarget(s as DiagScreen, { do: "press", id });
      expect("target" in f && f.target.what).toBe(what);
    }
    const bsart = s?.windows[0]?.elements.find((e) => e.name === "MEPO_TOPLINE-BSART");
    expect(bsart).toMatchObject({ kind: "dropdown", key: "NB", fcode: "MEDOCTYPE" });
  });
});

describe("other screens from a live capture", () => {
  test("VA03 after an error: SAP sends only what changed, and the labels and buttons stay", () => {
    const screens = replay("va03-error.bin");
    expect(screens.length).toBe(3);
    for (const s of screens.slice(1)) {
      const v = diagView(s);
      expect(v).toContain('RV45A-TXT_VBELN@1="Order"');
      expect(v).toContain("r5  Purchase Order No.  RV45S-BSTNK@22=[]");
      expect(v).toContain("r6  Sold-To Party  RV45S-KUNNR@22=[]");
      expect(v).toContain("<Search>{SUCH}@1");
    }
    expect(screens[1]?.message).toMatchObject({ type: "E", text: "SD document 50455045 is not in the database or has been archived" });
    expect(screens[1]?.windows[0]?.elements.find((e) => e.name === "VBAK-VBELN")?.text).toBe("50455045");
  });

  test("the SAP menu, a large tree, is shown as it is on show, not with its closed folders", () => {
    const [s] = replay("easy-access.bin");
    const v = diagView(s as DiagScreen);
    expect(v).toContain("14 nodes on show");
    expect(v).toContain("(97 more nodes in closed folders)");
    expect(v).not.toContain("(in a closed folder)");
  });

  test("MB52: a radio button with a function code reads its text without the code", () => {
    const [s] = replay("mb52-radio.bin");
    expect(s?.windows[0]?.elements.find((e) => e.name === "PA_HSQ")).toMatchObject({ kind: "radio", text: "Hierarchical Representation", fcode: "ALVV" });
  });

  test("MMBE: the stock tree shows its closed levels, and a key is taken without SAP's leading blanks", () => {
    const [s] = replay("mmbe-tree.bin");
    const v = diagView(s as DiagScreen);
    // Each value with its column's heading: "Unrestricted use", not a bare number among fourteen columns.
    expect(v).toContain("  [+] Full | Unrestricted use=40,000 (selected)  {1}");
    expect(v).toContain("        0001 Materiallager | Unrestricted use=40,000 (in a closed folder)  {4}");
    const tree = s?.windows[0]?.controls.find((c) => c.tree);
    expect(tree?.tree?.nodes[0]?.key).toBe("          1");
    const geo: Geometry = { at: () => [100, 100], cells: { cw: 8, ch: 20, x0: 0, y0: 0 } as never, controls: [{ cls: "SAPTreeList", rect: [100, 100, 400, 300] }] };
    for (const node of ["1", "          1", " 1 "]) {
      const p = planTree(s as DiagScreen, { do: "tree", id: "CC_CONTAINER", node, how: "expand" }, geo);
      expect(p.note).toBe('expanded node "Full" {1} of CC_CONTAINER');
    }
  });
});

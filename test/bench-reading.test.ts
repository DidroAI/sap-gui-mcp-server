/**
 * Screen-reading bugs found by the Haiku benchmark of 2026-11-23, each of
 * which gave a silent wrong answer, on screens rebuilt from the runs' tool
 * outputs (test/fixtures/lists.ts and the lines below).
 */
import { describe, expect, test } from "bun:test";
import { compact } from "../src/core/compact.js";
import { decimalOf, numbersLine } from "../src/core/notation.js";
import { pageOf, readRows, titleRowsOf } from "../src/core/rows.js";
import { entryFor } from "../src/webgui/controls.js";
import { cellLessTables, spliceTable } from "../src/webgui/reader.js";
import { FBL5N, listSource, listView, ME2L } from "./fixtures/lists.js";

const rowLines = (out: string) => out.split("\n").filter((l) => /^ {2}row \d+/.test(l));
const numberOf = (l: string) => Number(/^ {2}row (\d+)/.exec(l)?.[1]);

describe("1. classic lists read page by page: every line once, title rows once, a true count", () => {
  for (const [name, f] of [
    ["SAP GUI", ME2L],
    ["Web GUI", { ...ME2L, webgui: true }],
  ] as const)
    test(`ME2L (P2P-05, ${name}): PO 4500001184 (lines 16 to 20) is read, the open quantity in pieces is 3090`, async () => {
      const out = await readRows(listSource(f), "usr", 0, 46);
      const rows = rowLines(out);
      expect(rows.map(numberOf)).toEqual(Array.from({ length: 46 }, (_, i) => i));
      expect(rows[16]).toBe("  row 16: 4500001184 {1} | NB {12} | 17300002 {17} | Domestic US Supplier 2 {28} | 001 {65} | 05/12/2021 {69}");
      // The title rows once, as titles; never among the rows.
      expect(out.split("\n").filter((l) => l.includes("PO         Type Supplier"))).toEqual(["  title 1: PO         Type Supplier   Name                                 PGp Order Date {1}"]);
      // Every PO once.
      const pos = rows.map((l) => /: (45\d{8}) \{1\}/.exec(l)?.[1]).filter(Boolean);
      expect(pos).toEqual(["4500000028", "4500000613", "4500000614", "4500001184", "4500001264", "4500001265", "4500001385", "4500001456", "4500001762"]);
      const open = rows.filter((l) => l.includes("Still to be delivered") && l.includes("PC {45}")).reduce((n, l) => n + Number((/\| ([\d,]+) \{27\}/.exec(l)?.[1] ?? "0").replace(/,/g, "")), 0);
      expect(open).toBe(3090);
      expect(out.split("\n").at(-1)).toStartWith("  (rows 0 to 45 of 47; the control is now scrolled there.");
    });

  test("ME2L: the last lines, read from the end of the list, keep their numbers", async () => {
    const out = await readRows(listSource(ME2L), "usr", 45, 46);
    expect(rowLines(out)).toEqual(["  row 45: Still to be invoiced {6} | 99 {27} | EA {45} | 9,900.00 {48} | USD {65} | 99.00 {70} | % {78}"]);
    expect(out.split("\n").at(-1)).toStartWith("  (rows 45 to 45 of 47;");
  });

  test("FBL5N (REP-06, ECC SAP GUI): 34 items, the customer header once, rows 0 to 55 of 56", async () => {
    const out = await readRows(listSource(FBL5N), "usr", 0, 60);
    const rows = rowLines(out);
    const items = rows.filter((l) => l.includes("EUR {72} | "));
    expect(items.length).toBe(34);
    expect(items.map(numberOf)).toEqual(Array.from({ length: 34 }, (_, i) => i));
    expect(new Set(items.map((l) => /\| (\d+) \{78\}$/.exec(l)?.[1])).size).toBe(34);
    // The header block of the customer: titles, once.
    expect(out.split("\n").filter((l) => l.includes("SudaTech GmbH"))).toEqual(["  title 2: Name {0} | SudaTech GmbH {26}"]);
    expect(rows.some((l) => l.includes("2004 {26}"))).toBe(false);
    expect(Math.max(...rows.map(numberOf))).toBe(55);
    expect(rows.find((l) => l.includes("***"))).toStartWith("  row 55: ");
    expect(out.split("\n").at(-1)).toStartWith("  (rows 0 to 55 of 56; the control is now scrolled there. Rows are numbered in the whole list (line 0 is the first line below 17 title rows)");
  });

  test("the title rows are measured on two pages one line apart, also when SAP GUI's page size is one off", () => {
    const a = pageOf(listView(FBL5N, 0, 0));
    const b = pageOf(listView(FBL5N, 1, 1));
    // One page alone guesses from the page size: 17 with it right, 18 with it one off.
    expect([a.titleRows, b.titleRows]).toEqual([17, 18]);
    for (const hint of [0, 16, 17, 18, 30]) expect(titleRowsOf([a, b], hint)).toBe(17);
    expect(titleRowsOf([pageOf(listView(ME2L, 0)), pageOf(listView(ME2L, 1))], 0)).toBe(5);
    expect(titleRowsOf([a], 17)).toBeUndefined();
  });
});

describe("3. rows have one number, the one rows= and actions take; the list's line says how a cell id counts", () => {
  test("Web GUI ME2L, first page: lines 0 to 15 on screen rows 5 to 20, so the next range starts at 16", () => {
    const lines = compact(listView({ ...ME2L, webgui: true }, 0)).split("\n");
    const head = lines.find((l) => l.startsWith("usr  list  ")) ?? "";
    expect(head).toContain('rows numbered in the whole list below its 5 title rows: "rows" and "row" in actions take these numbers');
    expect(head).toContain("row N is usr/lbl[col,N+5] now");
    expect(lines).toContain("  title 1: PO         Type Supplier   Name                                 PGp Order Date {1}");
    expect(lines.filter((l) => l.startsWith("  row ")).at(-1)).toBe("  row 15: Still to be invoiced {6} | 910 {27} | PC {45} | 2,730.00 {48} | USD {65} | 100.00 {70} | % {78}");
  });
  test("SAP GUI says no title rows: its list rows stay screen rows, and the head says how rows= counts", () => {
    const head = compact(listView(FBL5N, 0)).split("\n").find((l) => l.startsWith("usr  list  ")) ?? "";
    expect(head).toContain("rows here are screen rows, as cell ids count them");
    expect(head).toContain('"rows" and scroll count the list\'s lines from 0, below its title rows');
  });
});

describe("2. a table control's values are read: Web GUI out of view, cells that are labels", () => {
  // MD-02 (S/4 Web GUI): the Output Tax table below the part of the page in view had its line and no cell.
  const OUT_OF_VIEW = [
    "TRANSACTION BP  PROGRAM SAPLBUS_LOCATOR  SCREEN 3000",
    'WINDOW wnd[0]  "Change Organization: USCU_S04, role Customer"',
    "wnd[0]/usr/boxGV_A06  group  Output Tax",
    "wnd[0]/usr/tblSAPLCVI_FS_UI_CUSTOMER_SALESTCTRL_KNVI  table  rows 9 (visible 8); columns: Dep. Ctry/Reg. | Country/Region | Tax Cndn Type | Name | Tax Classific. | Description",
    "wnd[0]/usr/btnPUSH_CVIC_TAX_LICENSE  button  Licenses  (License Detail)",
  ].join("\n");
  const T = "wnd[0]/usr/tblSAPLCVI_FS_UI_CUSTOMER_SALESTCTRL_KNVI";
  // The same table read again with it scrolled into view (cells as the S/4 SAP GUI run showed them).
  const IN_VIEW = [
    OUT_OF_VIEW.split("\n").slice(0, 4).join("\n"),
    `${T}/ctxtGT_KNVI_TC-ALAND[0,0]  field  Dep. Ctry/Reg. = "DE"  (read-only)`,
    `${T}/txtGT_KNVI_TC-ALANDT[1,0]  field  Country/Region = "Germany"  (read-only)`,
    `${T}/ctxtGT_KNVI_TC-TATYP[2,0]  field  Tax Cndn Type = "TTX1"  (read-only)`,
    `${T}/txtGT_KNVI_TC-TATYPT[3,0]  field  Name = "Output Tax"  (read-only)`,
    `${T}/ctxtGT_KNVI_TC-TAXKD[4,0]  field  Tax Classific. = ""  (edit)`,
    `${T}/ctxtGT_KNVI_TC-ALAND[0,1]  field  Dep. Ctry/Reg. = "US"  (read-only)`,
    `${T}/ctxtGT_KNVI_TC-TATYP[2,1]  field  Tax Cndn Type = "UTXJ"  (read-only)`,
    `${T}/ctxtGT_KNVI_TC-TAXKD[4,1]  field  Tax Classific. = "0"  (edit)`,
    "wnd[0]/usr/btnPUSH_CVIC_TAX_LICENSE  button  Licenses  (License Detail)",
  ].join("\n");

  test("a table without a cell in the view is not said to be empty", () => {
    const out = compact(OUT_OF_VIEW);
    expect(out).not.toContain("no row is filled");
    expect(out).toContain('  (no cell of this table is in the view: its rows on screen are blank lines, or the table is outside the part of the page that is drawn. sap_look with id "tblSAPLCVI_FS_UI_CUSTOMER_SALESTCTRL_KNVI" reads it on its own.)');
  });
  test("Web GUI reads such a table again in view: its cells take the place of its line", () => {
    expect(cellLessTables(OUT_OF_VIEW)).toEqual([T]);
    expect(cellLessTables(IN_VIEW)).toEqual([]);
    const spliced = spliceTable(OUT_OF_VIEW, IN_VIEW, T);
    expect(spliced.split("\n").at(-1)).toBe("wnd[0]/usr/btnPUSH_CVIC_TAX_LICENSE  button  Licenses  (License Detail)");
    const out = compact(spliced);
    expect(out).toContain("  row 0: Dep. Ctry/Reg.=DE; Country/Region=Germany; Tax Cndn Type=TTX1; Name=Output Tax");
    expect(out).toContain("  row 1: Dep. Ctry/Reg.=US; Tax Cndn Type=UTXJ; Tax Classific.=0");
    // Read again and still no cell: the view stays as it was.
    expect(spliceTable(OUT_OF_VIEW, OUT_OF_VIEW, T)).toBe(OUT_OF_VIEW);
  });
  test("cells that are labels (SAP GUI GuiLabel) or radio buttons hold values: the row is filled", () => {
    const view = [
      "wnd[0]/usr/tblT  table  rows 2 (visible 2); columns: Country | Tax category | Kind",
      "wnd[0]/usr/tblT/lblKNVI-ALAND[0,0]  label  DE",
      "wnd[0]/usr/tblT/lblKNVI-TATYP[1,0]  label  TTX1",
      "wnd[0]/usr/tblT/radKNVI-KIND[2,0]  radio  [x] ",
    ].join("\n");
    const out = compact(view);
    expect(out).toContain("  row 0: Country=DE; Tax category=TTX1; Kind [x]");
    expect(out).not.toContain("no cell of this table");
  });
});

describe("4. a dropdown entry is chosen by its exact key, the blank one included", () => {
  // VA02 (W-C03, ECC Web GUI): the delivery block, as `combo` without a key listed it.
  const LIFSK = [
    ["44", "'Pre-production'"],
    ["03", "Bottleneck material"],
    ["91", "Customer Request"],
    ["97", "DEA: Check Form 222"],
    ["98", "DEA: Qty Tolerance"],
    [" ", ""],
  ].map(([key, text]) => ({ key: key ?? "", text: text ?? "" }));
  const sid = "wnd[0]/usr/cmbVBAK-LIFSK";
  test("the blank entry: by an empty key, a space, or ':' as the list writes it", () => {
    for (const w of ["", " ", "  ", ":", " :"]) expect(entryFor(sid, LIFSK, w)).toEqual({ key: " ", text: "", blank: true });
  });
  test("a key, key:text, key text, or a whole text", () => {
    for (const w of ["91", "91:Customer Request", "91 Customer Request", "customer request", "91:"]) expect(entryFor(sid, LIFSK, w)).toEqual({ key: "91", text: "Customer Request", blank: false });
  });
  test("no part of a text that is not whole words is matched: ':' chose 97 (DEA: Check Form 222)", () => {
    for (const w of ["9", "Cust", "Form 22"]) {
      const r = entryFor(sid, LIFSK, w);
      expect(typeof r).toBe("string");
      expect(r as string).toStartWith(`no entry "${w}" in ${sid}: give an entry's key exactly ("" for the blank entry, which clears the field). Its entries (key:text): 44:'Pre-production', 03:Bottleneck material, 91:Customer Request`);
    }
    // Whole words of one text choose it; of several, the answer names their keys.
    expect(entryFor(sid, LIFSK, "Customer")).toEqual({ key: "91", text: "Customer Request", blank: false });
    expect(entryFor(sid, LIFSK, "check form")).toEqual({ key: "97", text: "DEA: Check Form 222", blank: false });
    for (const w of ["DEA:", "DEA"]) expect(entryFor(sid, LIFSK, w)).toStartWith(`"${w}" is ambiguous in ${sid}: 97, 98 (each with "${w}" in its text: DEA: Check Form 222, DEA: Qty Tolerance)`);
  });
  test("a text two entries share is ambiguous, with their keys; a long list is cut (ME21N order types, live 2026-11-23: 5.3 KB)", () => {
    const types = [...Array.from({ length: 37 }, (_, i) => ({ key: `Z${i}`, text: `Type ${i}` })), { key: "AR", text: "Standard PO" }, { key: "NB", text: "Standard PO" }];
    expect(entryFor(sid, types, "Standard PO")).toBe(`"Standard PO" is ambiguous in ${sid}: AR, NB (each "Standard PO"). Give the key of the entry you mean.`);
    const none = entryFor(sid, types, "Rush order") as string;
    expect(none).toEndWith("Z14:Type 14 and 24 more (a combo with no key lists them all)");
    expect(none.length).toBeLessThan(400);
  });
  test("a dropdown without a blank entry cannot be cleared: said", () => {
    expect(entryFor(sid, LIFSK.slice(0, 2), "")).toBe(`${sid} has no blank entry, so it cannot be cleared: choose one of its entries (key:text): 44:'Pre-production', 03:Bottleneck material`);
  });
});

describe("5. the user's number notation, once, under the header", () => {
  test("NUMBERS for a decimal comma (FBL5N, ECC) and a decimal point (ME2L, S/4)", () => {
    const fbl5n = compact(listView(FBL5N, 0)).split("\n");
    expect(fbl5n[1]).toBe('NUMBERS 1.234,56  (decimal comma: "1.000" is one thousand, "1,000" is one, "312,000" is 312)');
    expect(fbl5n.filter((l) => l.startsWith("NUMBERS ")).length).toBe(1);
    expect(compact(listView(ME2L, 0)).split("\n")[1]).toBe('NUMBERS 1,234.56  (decimal point: "1,000" is one thousand, "1.000" is one)');
  });
  test("list cells are values: their column in braces is not part of the number", () => {
    expect(decimalOf("  row 17: [ ] {1} | RV {11} | 130.005,98 {53} | EUR {72}")).toEqual({ sign: ",", example: "130.005,98" });
  });
  test("a screen without an amount says nothing, unless the surface knows the user's setting", () => {
    // MB51 (INV-06): quantities "1-" and "1.000" alone do not tell the notation.
    const mb51 = ["TRANSACTION MB51  PROGRAM SAPLSLVC_FULLSCREEN  SCREEN 500", 'WINDOW wnd[0]  "Material Document List"', "cntlGRID1/shell  grid  2 rows; columns: BWART=MvT | ERFMG=Qty in unit of entry", "  row 0: 601 | 1-", "  row 1: 561 | 1.000"].join("\n");
    expect(compact(mb51)).not.toContain("NUMBERS");
    expect(compact(mb51, { decimal: "," }).split("\n")[1]).toBe(numbersLine(","));
    expect(compact(listView(FBL5N, 0), { numbers: false })).not.toContain("NUMBERS");
  });
  test("a grouping by spaces is shown as such", () => {
    expect(numbersLine(",", "1 250,00")).toStartWith("NUMBERS 1 234,56  (decimal comma");
  });
});

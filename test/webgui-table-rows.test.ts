/**
 * Rows of a Web GUI table control by the one number the view prints (live
 * 2026-11-23, MM03 "Select View(s)": after a scroll to 10 the view printed
 * "row 12 (cell row 2): View=MRP 2", and "select row 12" selected the row
 * it called 22). A synthetic table of 30 rows that shows 5, with Web GUI's
 * markup and a stand-in for its scrollbar object (see webgui-lists.test.ts).
 * Needs a Chrome:
 *
 *   SAP_TEST_CHROME=/path/to/chrome bun test test/webgui-table-rows.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { webguiActInFrame, webguiLookInFrame } from "../src/webgui/index.js";
import { view } from "../src/webgui/reader.js";
import { WebGuiSession } from "../src/webgui/session.js";

const exe = process.env.SAP_TEST_CHROME;
const sid = (id: string, type: string) => `{ModalNo:0,SID:'${id}',Type:'${type}'}`;
const T = "wnd[0]/usr/tblZVIEWS";
const SEL = "urBorderBox urSTSCOuterDiv urSTRowSelSecIcon urST4LbSelIcon";
const UNSEL = "urBorderBox urSTSCOuterDiv urSTRowUnSelIcon urST4LbUnselIcon";

const PAGE = `<!doctype html><html lang="en"><head><title>Synthetic</title></head><body>
<div id="cuaheader" lsdata="{1:'Select\\x20views'}">Select views</div>
<input id="ToolbarOkCode" lsdata="{0:'FREETEXT',20:${sid("wnd[0]/tbar[0]/okcd", "GuiOKCodeField")}}">
<table id="tbl1" ct="STCS" lsdata="{10:'MULTI',29:{ColumnIds:['MSICHTAUSW-DYTXT','ZX-MAT'],${sid(T, "GuiTableControl").slice(1)}}" style="width:600px">
  <thead><tr><th lsmatrixrowindex="0" lsmatrixcolindex="1" lsdata="{17:${sid(`${T}/colMSICHTAUSW-DYTXT`, "GuiTableColumn")}}">View</th>
      <th lsmatrixrowindex="0" lsmatrixcolindex="2" lsdata="{17:${sid(`${T}/colZX-MAT`, "GuiTableColumn")}}">Material</th></tr></thead>
  <tbody id="ROWS"></tbody>
</table>
<div id="tbl1-vscroll" ct="SCB" style="width:16px;height:60px" lsdata="{0:1,1:26,3:5,6:'tbl1',10:30}">&nbsp;</div>
<div id="msgarea"><span ct="TV">XYZ (100)</span></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_TRANSACTION" lsdata="{13:'MM03'}"></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_DYNPRO" lsdata="{13:'SAPLMGMM/0070'}"></div>
<script>
  window.sel = {};
  window.mat = {};
  window.first = 0;
  function sid(id, type) { return "{ModalNo:0,SID:'" + id + "',Type:'" + type + "'}"; }
  function draw(first) {
    window.first = first;
    var rows = '';
    for (var i = 0; i < 5; i++) {
      var n = first + i;
      var on = !!window.sel[n];
      rows += '<tr><td subct="SC" lsmatrixrowindex="' + (i + 1) + '" lsmatrixcolindex="0" class="urSTSC" onclick="toggleRow(' + n + ')"><div class="' + (on ? '${SEL}' : '${UNSEL}') + '">&nbsp;</div></td>'
        + '<td><span class="lsField lsField--table lsField--readonly"><input readonly value="View ' + n + '" lsdata="{0:\\'FREETEXT\\',20:' + sid('${T}/txtMSICHTAUSW-DYTXT[0,' + i + ']', 'GuiTextField') + '}"></span></td>'
        + '<td><span class="lsField lsField--table"><input value="' + (window.mat[n] || '') + '" oninput="window.mat[' + n + ']=this.value" lsdata="{0:\\'FREETEXT\\',20:' + sid('${T}/ctxtZX-MAT[1,' + i + ']', 'GuiCTextField') + '}"></span></td></tr>';
    }
    document.getElementById('ROWS').innerHTML = rows;
    document.getElementById('tbl1-vscroll').setAttribute('lsdata', "{0:" + (first + 1) + ",1:26,3:5,6:'tbl1',10:30}");
  }
  function toggleRow(n) { window.sel[n] = !window.sel[n]; draw(window.first); }
  function UCF_Scrollbar() { this.pos = 1; }
  UCF_Scrollbar.prototype.onmouseup = function () {};
  UCF_Scrollbar.prototype.iGetFirstVisibleItem = function () { return this.pos; };
  UCF_Scrollbar.prototype.iGetMaxScrollTo = function () { return 26; };
  UCF_Scrollbar.prototype.scrollToPosition = function (n) { this.pos = n; window.scrolls = (window.scrolls || []).concat(n); draw(n - 1); };
  var bar = new UCF_Scrollbar();
  document.getElementById('tbl1-vscroll').addEventListener('mouseup', function (e) { bar.onmouseup(e); });
  draw(0);
</script>
</body></html>`;

const refusal = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "",
    (e: unknown) => (e as Error).message,
  );

describe.skipIf(!exe)("Web GUI table control: one row number for the view and the actions, in a browser", () => {
  let browser: Browser;
  let page: Page;
  const compactView = async () => ((await webguiLookInFrame(page.mainFrame(), true)) ?? "").split("\n");
  const fullView = async () => ((await webguiLookInFrame(page.mainFrame(), false)) ?? "").split("\n");
  const NOTHING_SENT = /\n(?:Nothing was sent to SAP for this action|\(Set in the page: SAP gets it|\(Done in the page)[^\n]*$/;
  const act = async (a: Parameters<typeof webguiActInFrame>[1]) => (await webguiActInFrame(page.mainFrame(), a)).replace(NOTHING_SENT, "");
  const state = () => page.evaluate(() => ({ first: (window as unknown as { first: number }).first, sel: Object.entries((window as unknown as { sel: Record<string, boolean> }).sel).filter(([, on]) => on).map(([n]) => Number(n)), mat: (window as unknown as { mat: Record<string, string> }).mat }));
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: exe!, headless: true, args: ["--no-sandbox"] });
    page = await browser.newPage({ viewport: { width: 1200, height: 1400 } });
    await page.setContent(PAGE);
  });
  afterAll(async () => {
    await browser?.close();
  });

  test("scrolled to 10, the view numbers the rows 10 to 14 and prints no cell row", async () => {
    expect(await act({ do: "scroll", id: "tblZVIEWS", to: 10 })).toBe(`scrolled ${T}: rows 10 to 14 of 30`);
    const c = await compactView();
    expect(c.find((l) => l.startsWith("tblZVIEWS  table"))).toBe(
      'tblZVIEWS  table  rows 30 (visible 5, first 10); rows can be selected  (rows numbered in the whole table: "row" in actions takes these numbers; a cell id counts rows on the screen: txtMSICHTAUSW-DYTXT[0,0] is row 10)',
    );
    expect(c).toContain("  row 12: View=View 12");
    expect(c.some((l) => l.includes("cell row"))).toBe(false);
  });

  test('"select row 12" selects the row the view calls 12, and the header names it 12', async () => {
    expect(await act({ do: "select", id: "tblZVIEWS", row: 12 })).toBe(`selected row 12 of ${T}`);
    expect((await state()).sel).toEqual([12]);
    expect((await fullView()).find((l) => l.startsWith(`${T}  table`))).toContain("selected rows 12;");
    expect(await compactView()).toContain("  row 12 (selected): View=View 12");
  });

  test("a row off the screen is scrolled to first", async () => {
    const out = await act({ do: "select", id: "tblZVIEWS", row: 2 });
    expect(out).toStartWith(`selected row 2 of ${T} (scrolled to it: rows 2 to 6 of 30 are shown)`);
    expect((await state()).sel).toEqual([2, 12]);
    expect(await act({ do: "check", id: "tblZVIEWS", row: 12, value: false })).toStartWith(`deselected row 12 of ${T}`);
    expect((await state()).sel).toEqual([2]);
    expect(await refusal(act({ do: "select", id: "tblZVIEWS", row: 30 }))).toBe(`row 30: ${T} has 30 rows (0 to 29).`);
  });

  test("set with row and col types into the cell: col by title, field name or number", async () => {
    await act({ do: "scroll", id: "tblZVIEWS", to: 0 });
    expect(await act({ do: "set", id: "tblZVIEWS", row: 1, col: "Material", value: "M-08" })).toBe(`set ${T}/ctxtZX-MAT[1,1] (row 1, column Material of ${T})`);
    expect(await act({ do: "set", id: "tblZVIEWS", row: 3, col: "ZX-MAT", value: "M-09" })).toBe(`set ${T}/ctxtZX-MAT[1,3] (row 3, column ZX-MAT of ${T})`);
    const far = await act({ do: "set", id: "tblZVIEWS", row: 20, col: "1", value: "M-20" });
    expect(far).toStartWith(`set ${T}/ctxtZX-MAT[1,`);
    expect(far).toContain("(row 20, column 1 of");
    expect(far).toContain("(scrolled to it:");
    expect((await state()).mat).toEqual({ 1: "M-08", 3: "M-09", 20: "M-20" });
  });

  test("set on the table without a column, or with one it does not have, names the forms that work", async () => {
    expect(await refusal(act({ do: "set", id: "tblZVIEWS", row: 1, value: "X" }))).toContain('needs "row" (as the view numbers it) and "col"');
    expect(await refusal(act({ do: "set", id: "tblZVIEWS", value: "X" }))).toContain("or use the cell's own id from the view (<table>/ctxt<FIELD>[col,<row on screen>])");
    expect(await refusal(act({ do: "set", id: "tblZVIEWS", row: 1, col: "Plant", value: "X" }))).toContain(`${T} has no column "Plant". "col" is a column number, title or field name: 0 View=txtMSICHTAUSW-DYTXT, 1 Material=ctxtZX-MAT.`);
  });

  test("a read of rows leaves the table where it was", async () => {
    await act({ do: "scroll", id: "tblZVIEWS", to: 7 });
    const out = (await view(new WebGuiSession(page.mainFrame()), { compact: true, id: "tblZVIEWS", rows: { from: 0, to: 29 } })).split("\n");
    expect(out.filter((l) => /^ {2}row \d+[ :]/.test(l)).length).toBe(30);
    // The head says where the table is now: where it was before the read.
    expect(out[2]).toStartWith("tblZVIEWS  table  rows 30 (visible 5, first 7);");
    expect(out.some((l) => l.includes("cell row") || l.includes("row 0 here"))).toBe(false);
    expect(out.at(-1)).toContain("the table is scrolled back to row 7, as it was.");
    expect((await state()).first).toBe(7);
  });
});

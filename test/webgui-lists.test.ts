/**
 * The Web GUI reader on long lists, dropdowns and handles, on a synthetic
 * page that uses Web GUI's markup: a classic list with its scrollbar, a
 * dropdown with its list box, two controls that share a last id segment.
 * It needs a Chrome to run in:
 *
 *   SAP_TEST_CHROME=/path/to/chrome bun test test/webgui-lists.test.ts
 *
 * Without SAP_TEST_CHROME the tests are skipped. No SAP data: the page is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Driver } from "../src/core/types.js";
import { webguiActInFrame, webguiAssessInFrame, webguiLookInFrame } from "../src/webgui/index.js";
import { view } from "../src/webgui/reader.js";
import { WebGuiSession } from "../src/webgui/session.js";

const exe = process.env.SAP_TEST_CHROME;
const sid = (id: string, type: string, modal = 0) => `{ModalNo:${modal},SID:'${id}',Type:'${type}'}`;
const cell = (c: number, r: number, text: string) => `<div ct="ALT" lsdata="{2:${sid(`wnd[0]/usr/lbl[${c},${r}]`, "ABAPLISTTEXT")}}">${text}</div>`;
const box = (c: number, r: number, on: boolean) => `<span ct="ALC" class="lsCheckBox ${on ? "lsCheckBox--checked" : ""}" lsdata="{2:${sid(`wnd[0]/usr/chk[${c},${r}]`, "ABAPLISTCHECKBOX")}}">&nbsp;</span>`;

/**
 * A list of 201 lines that shows three at a time below one title line. The
 * scrollbar object is a stand-in for Web GUI's: like the real one it is not
 * reachable by id, handles the mouseup of its element, and moves the list
 * with scrollToPosition (here: it redraws the lines and its own lsdata).
 */
const PAGE = `<!doctype html><html lang="en"><head><title>Synthetic</title></head><body>
<div id="cuaheader" lsdata="{1:'Synthetic\\x20list'}">Synthetic list</div>
<input id="ToolbarOkCode" lsdata="{0:'FREETEXT',20:${sid("wnd[0]/tbar[0]/okcd", "GuiOKCodeField")}}">
<div title="Back (F3)" lsdata="{0:'Back',19:'F3',28:${sid("wnd[0]/tbar[0]/btn[3]", "GuiButton")}}">Back</div>
<div title="Choose (F2)" lsdata="{0:'Choose',19:'F2',28:${sid("wnd[0]/tbar[1]/btn[2]", "GuiButton")}}">Choose</div>
<label id="L1" lsdata="{1:'C1',3:'Delivery\\x20block',19:${sid("wnd[0]/usr/lblZHDR-BLOCK", "GuiLabel")}}">Delivery block</label>
<input id="C1" value="Credit limit" lsdata="{2:'C1_LB',3:'01',4:'Credit\\x20limit',20:${sid("wnd[0]/usr/cmbZHDR-BLOCK", "GuiComboBox")}}">
<div id="C1_LB" style="display:none"><div ct="LIB_I" data-itemkey="" lsdata="{4:'No\\x20block'}"></div><div ct="LIB_I" data-itemkey="01" lsdata="{4:'Credit\\x20limit'}"></div><div ct="LIB_I" data-itemkey="02" lsdata="{4:'Political\\x20reasons'}"></div></div>
<textarea id="E1" lsdata="{0:'x',20:${sid("wnd[0]/usr/cntlNOTE_A/shellcont/shell", "GuiTextEdit")}}">first note</textarea>
<textarea id="E2" lsdata="{0:'x',20:${sid("wnd[0]/usr/cntlNOTE_B/shellcont/shell", "GuiTextEdit")}}">second note</textarea>
<table id="userarealist0" ct="AL" lsdata="{4:201,5:1,6:3,10:${sid("wnd[0]/usr", "ABAPLIST")}}"><tbody id="LINES"></tbody></table>
<div id="userarealist0-scrollV" ct="SCB" style="width:16px;height:60px" lsdata="{0:1,1:199,2:1,3:3,6:'userarealist0',8:'ROW',10:201}">&nbsp;</div>
<div id="msgarea"><span ct="TV">XYZ (100)</span></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_SYSTEM" lsdata="{0:'abc',1:'System',13:'XYZ\\x20(100)'}"></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_TRANSACTION" lsdata="{13:'ZT16'}"></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_DYNPRO" lsdata="{13:'ZLIST/0120'}"></div>
<script>
  function draw(first) {
    var rows = '<tr><td>${cell(3, 0, "Type").replace(/'/g, "\\'")}${cell(9, 0, "Name").replace(/'/g, "\\'")}</td></tr>';
    for (var i = 0; i < 3; i++) {
      var n = first + i;
      rows += '<tr><td><span ct="ALC" class="lsCheckBox' + (n === 1 ? ' lsCheckBox--checked' : '') + '" lsdata="{2:{ModalNo:0,SID:\\'wnd[0]/usr/chk[1,' + (i + 1) + ']\\',Type:\\'ABAPLISTCHECKBOX\\'}}">&nbsp;</span>'
        + '<div ct="ALT" lsdata="{2:{ModalNo:0,SID:\\'wnd[0]/usr/lbl[3,' + (i + 1) + ']\\',Type:\\'ABAPLISTTEXT\\'}}">T' + n + '</div>'
        + '<div ct="ALT" lsdata="{2:{ModalNo:0,SID:\\'wnd[0]/usr/lbl[9,' + (i + 1) + ']\\',Type:\\'ABAPLISTTEXT\\'}}">Name ' + n + '</div></td></tr>';
    }
    document.getElementById('LINES').innerHTML = rows;
    document.getElementById('userarealist0-scrollV').setAttribute('lsdata', "{0:" + (first + 1) + ",1:199,2:1,3:3,6:'userarealist0',8:'ROW',10:201}");
  }
  function UCF_Scrollbar() { this.pos = 1; }
  UCF_Scrollbar.prototype.onmouseup = function () {};
  UCF_Scrollbar.prototype.iGetFirstVisibleItem = function () { return this.pos; };
  UCF_Scrollbar.prototype.iGetMaxScrollTo = function () { return 199; };
  UCF_Scrollbar.prototype.scrollToPosition = function (n) { this.pos = n; window.scrolls = (window.scrolls || []).concat(n); draw(n - 1); };
  var bar = new UCF_Scrollbar();
  document.getElementById('userarealist0-scrollV').addEventListener('mouseup', function (e) { bar.onmouseup(e); });
  draw(0);
</script>
</body></html>`;

/** What an action was refused with; "" when it ran. (bun's `expect(p).rejects` makes a browser call take a second: not used here.) */
const refusal = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "",
    (e: unknown) => (e as Error).message,
  );

describe.skipIf(!exe)("Web GUI reader: lists, dropdowns and handles, in a browser", () => {
  let browser: Browser;
  let page: Page;
  const compactView = async () => ((await webguiLookInFrame(page.mainFrame(), true)) ?? "").split("\n");
  const fullView = async () => ((await webguiLookInFrame(page.mainFrame(), false)) ?? "").split("\n");
  const look: Driver["look"] = (options) => view(new WebGuiSession(page.mainFrame()), options);
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: exe!, headless: true, args: ["--no-sandbox"] });
    page = await browser.newPage();
    await page.setContent(PAGE);
  });
  afterAll(async () => {
    await browser?.close();
  });

  test("a classic list is read: a line for the list, then each cell by column and row", async () => {
    const full = await fullView();
    expect(full).toContain("wnd[0]/usr  list  201 rows (visible 3, below 1 title rows; scroll for the others)");
    expect(full).toContain("wnd[0]/usr/lbl[3,0]  label  Type");
    expect(full).toContain("wnd[0]/usr/chk[1,2]  checkbox  [x] ");
    expect(full).toContain("wnd[0]/usr/lbl[9,3]  label  Name 2");
  });

  test("the compact view writes it as one line per row of the list, and shortens the button ids", async () => {
    const c = await compactView();
    expect(c).toContain("btn[3]  button  Back (F3)");
    expect(c).toContain("btn[2]  button  Choose (F2)");
    const at = c.findIndex((l) => l.startsWith("usr  list  "));
    expect(c.slice(at, at + 5)).toEqual([
      'usr  list  201 rows (visible 3, below 1 title rows; scroll for the others)  (rows numbered in the whole list below its 1 title row, as "rows" and scroll count them; a cell id counts rows on screen: usr/lbl[col,<cell row>], col in braces; rows without braces have their cells in columns 1,3,9; a checkbox is chk[col,<cell row>])',
      "  title 0: Type {3} | Name {9}",
      "  row 0 (cell row 1): [ ] | T0 | Name 0",
      "  row 1 (cell row 2): [x] | T1 | Name 1",
      "  row 2 (cell row 3): [ ] | T2 | Name 2",
    ]);
  });

  test("scroll moves the list through its scrollbar object and says where it is", async () => {
    const f = page.mainFrame();
    expect((await webguiAssessInFrame(f, { do: "scroll", id: "usr", to: 50 })).risk).toBe("read");
    expect(await webguiActInFrame(f, { do: "scroll", id: "usr", to: 50 })).toBe("scrolled wnd[0]/usr: rows 50 to 52 of 201");
    expect(await page.evaluate(() => (window as unknown as { scrolls: number[] }).scrolls)).toEqual([51]);
    const c = await compactView();
    expect(c).toContain("  row 50 (cell row 1): [ ] | T50 | Name 50");
    expect(c.find((l) => l.startsWith("usr  list  "))).toContain("201 rows (visible 3, first 50, below 1 title rows; scroll for the others)");
    expect(await webguiActInFrame(f, { do: "scroll", id: "usr", to: "next" })).toBe("scrolled wnd[0]/usr: rows 53 to 55 of 201");
    expect(await webguiActInFrame(f, { do: "scroll", id: "usr", to: "last" })).toBe("scrolled wnd[0]/usr: rows 198 to 200 of 201");
    expect(await webguiActInFrame(f, { do: "scroll", id: "usr", to: "next" })).toBe("wnd[0]/usr is already there: rows 198 to 200 of 201");
    // Without an id: the one control of the screen that scrolls.
    expect(await webguiActInFrame(f, { do: "scroll", to: "first" })).toBe("scrolled wnd[0]/usr: rows 0 to 2 of 201");
  });

  test("a range of rows is read by scrolling; title rows stay apart", async () => {
    const out = (await look({ compact: true, id: "usr", rows: { from: 10, to: 16 } })).split("\n");
    expect(out.slice(2)).toEqual([
      "usr  list  201 rows (visible 3, first 14, below 1 title rows; scroll for the others)  (cell ids: usr/lbl[col,row], col in braces; a checkbox is chk[col,row])",
      "  title 0: Type {3} | Name {9}",
      "  row 10: [ ] {1} | T10 {3} | Name 10 {9}",
      "  row 11: [ ] {1} | T11 {3} | Name 11 {9}",
      "  row 12: [ ] {1} | T12 {3} | Name 12 {9}",
      "  row 13: [ ] {1} | T13 {3} | Name 13 {9}",
      "  row 14 (cell row 1): [ ] {1} | T14 {3} | Name 14 {9}",
      "  row 15 (cell row 2): [ ] {1} | T15 {3} | Name 15 {9}",
      "  row 16 (cell row 3): [ ] {1} | T16 {3} | Name 16 {9}",
      '  (rows 10 to 16 of 201; the control is now scrolled there. Rows are numbered in the whole list (line 0 is the first line below 1 title row), as "rows" and scroll count them; a cell id counts rows on screen: a row on screen now says its cell row (row 14 is lbl[col,1]), scroll to the others before acting on them.)',
    ]);
    await webguiActInFrame(page.mainFrame(), { do: "scroll", id: "usr", to: "first" });
  });

  test("a dropdown shows its entry and the count; its entries come on request and nothing is chosen", async () => {
    const f = page.mainFrame();
    expect(await fullView()).toContain('wnd[0]/usr/cmbZHDR-BLOCK  dropdown  Delivery block = "01" Credit limit  (edit)  3 options: :No block, 01:Credit limit, 02:Political reasons');
    expect(await compactView()).toContain('cmbZHDR-BLOCK  dropdown  Delivery block = "01" Credit limit  (edit)  (3 options)');
    expect((await webguiAssessInFrame(f, { do: "combo", id: "cmbZHDR-BLOCK" })).risk).toBe("read");
    expect(await webguiActInFrame(f, { do: "combo", id: "cmbZHDR-BLOCK" })).toBe("wnd[0]/usr/cmbZHDR-BLOCK has 3 entries: :No block, 01:Credit limit, 02:Political reasons");
    expect(await page.locator("#C1").inputValue()).toBe("Credit limit");
    expect((await look({ compact: true, id: "cmbZHDR-BLOCK" })).split("\n").at(-1)).toBe('cmbZHDR-BLOCK  dropdown  Delivery block = "01" Credit limit  (edit)  3 options: :No block, 01:Credit limit, 02:Political reasons');
  });

  test("two controls that share their last segment get handles, and every action resolves them", async () => {
    const f = page.mainFrame();
    const c = await compactView();
    expect(c).toContain('cntlNOTE_A/shell  text-editor  "first note"');
    expect(c).toContain('cntlNOTE_B/shell  text-editor  "second note"');
    expect(await webguiActInFrame(f, { do: "set", id: "cntlNOTE_B/shell", value: "changed" })).toBe("set wnd[0]/usr/cntlNOTE_B/shellcont/shell");
    expect(await page.locator("#E2").inputValue()).toBe("changed");
    expect(await page.locator("#E1").inputValue()).toBe("first note");
  });

  test("an id that names several controls is refused with the list of them; nothing is typed", async () => {
    const f = page.mainFrame();
    const message = '"shell" names 2 controls on this screen: cntlNOTE_A/shell, cntlNOTE_B/shell. Use one of these ids.';
    expect(await refusal(webguiActInFrame(f, { do: "set", id: "shell", value: "wrong" }))).toContain(message);
    expect(await refusal(webguiAssessInFrame(f, { do: "press", id: "shell" }))).toContain(message);
    expect(await page.locator("#E1").inputValue()).toBe("first note");
  });

  test("an id of another screen is refused, not matched to something near", async () => {
    const f = page.mainFrame();
    expect(await refusal(webguiActInFrame(f, { do: "set", id: "ctxtZOLD-FIELD", value: "1" }))).toContain('No control "ctxtZOLD-FIELD" on this screen.');
    expect(await refusal(webguiActInFrame(f, { do: "grid", id: "cntlOLD_GRID/shell", row: 0, col: "A" }))).toContain("no tree or grid named cntlOLD_GRID/shell on this screen");
    expect(await refusal(webguiActInFrame(f, { do: "scroll", id: "cntlOLD_GRID/shell", to: 5 }))).toContain("no grid, table, tree or list named cntlOLD_GRID/shell");
  });

  test("one control alone, by its handle", async () => {
    expect((await look({ compact: true, id: "cntlNOTE_A/shell" })).split("\n").slice(2)).toEqual(['cntlNOTE_A/shell  text-editor  "first note"']);
    expect(await refusal(look({ compact: true, id: "cntlNONE/shell" }))).toContain('No control "cntlNONE/shell" on this screen');
  });
});

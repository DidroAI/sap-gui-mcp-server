/**
 * Controls of Web GUI that answer late or keep their parts out of the usual
 * places, on a synthetic page built from snippets of real Web GUI markup
 * (ECC, SAP GUI for HTML, read on 2026-11-16; values made up, no SAP data):
 *
 * - a table control marks a row about 350 ms after the click on its row
 *   selector, in the page, with no request;
 * - the horizontal scrollbar of a table control counts pixels from 0 and its
 *   lsdata holds no position;
 * - the rows of a dropdown button's menu have a DOM id that changes each
 *   time the menu opens (u1234); their scripting id is in lsdata;
 * - a click on a line of a classic list is sent 300 ms after it, and in a
 *   popup the first one can do no more than give the line the cursor;
 * - the restrictions of a value help are a panel closed by default, opened
 *   with the arrow left of its title; its fields are GuiSearchHelpPageItem;
 * - the calendar of a date's value help holds its date in a field of its own;
 * - the text SAP writes after a field (the description of its value) points
 *   at the field as its label does, and a label can point at a button;
 * - a grid's column is selected by a click on its header;
 * - a tree node's first text element is empty and has no size; the node
 *   clicked last has a class on its hierarchy cell.
 *
 * Needs a Chrome: SAP_TEST_CHROME=/path/to/chrome. Without it the tests are skipped.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { webguiAssessInFrame, webguiLookInFrame } from "../src/webgui/index.js";
import { act as actRaw } from "../src/webgui/reader.js";
import { WebGuiSession } from "../src/webgui/session.js";

const exe = process.env.SAP_TEST_CHROME;
const sid = (id: string, type: string, modal = 0) => `{ModalNo:${modal},SID:'${id}',Type:'${type}'}`;
const URL_ = "http://sap.test/sap/bc/gui/sap/its/webgui?sap-client=100";
const UNSEL = "urBorderBox urSTSCOuterDiv urSTRowUnSelIcon urST4LbUnselIcon";
const SEL = "urBorderBox urSTSCOuterDiv urSTRowSelSecIcon urST4LbSelIcon";
const row = (r: number, item: string) =>
  `<tr><td id="tbl1[${r},0]" subct="SC" lsmatrixrowindex="${r}" lsmatrixcolindex="0" class="urSTSC" onclick="selectLate(this)"><div class="${UNSEL}">&nbsp;</div></td>` +
  `<td><span class="lsField lsField--readonly"><input value="${item}" readonly lsdata="{0:'x',20:${sid(`wnd[0]/usr/tblZTC_ITEMS/txtZV-POSNR[0,${r - 1}]`, "GuiTextField")}}"></span></td></tr>`;

const PAGE = `<!doctype html><html lang="en"><head><title>Synthetic</title></head><body>
<div id="cuaheader" lsdata="{1:'Synthetic\\x20controls'}">Synthetic controls</div>
<input id="ToolbarOkCode" lsdata="{0:'FREETEXT',20:${sid("wnd[0]/tbar[0]/okcd", "GuiOKCodeField")}}">

<table id="tbl1" ct="STCS" lsdata="{10:'MULTI',29:{ColumnIds:['ZV-POSNR'],${sid("wnd[0]/usr/tblZTC_ITEMS", "GuiTableControl").slice(1)}}" style="width:300px">
  <tr><th lsmatrixrowindex="0" lsmatrixcolindex="1" lsdata="{17:${sid("wnd[0]/usr/tblZTC_ITEMS/colZV-POSNR", "GuiTableColumn")}}">Item</th></tr>
  ${row(1, "10")}${row(2, "20")}
</table>
<div id="tbl1_vscroll" ct="SCB" style="width:16px;height:40px" lsdata="{0:1,1:1,3:2,6:'tbl1',10:2}">&nbsp;</div>
<div id="tbl1_hscroll" ct="SCB" style="width:300px;height:16px" lsdata="{1:0,3:-100,5:'HORIZONTAL',6:'tbl1'}">&nbsp;</div>

<label id="LA" style="position:absolute;left:600px;top:20px" lsdata="{1:'BTNS',3:'Customer',19:${sid("wnd[0]/usr/lblRF02D-KUNNR", "GuiLabel")}}">Customer</label>
<div id="BTNS" style="position:absolute;left:700px;top:20px;width:20px" title="Search" lsdata="{4:'Search',28:${sid("wnd[0]/usr/btnSEARCH_CUSTOMER", "GuiButton")}}">S</div>
<input id="FK" style="position:absolute;left:730px;top:20px;width:80px" value="1000" lsdata="{0:'x',20:${sid("wnd[0]/usr/ctxtRF02D-KUNNR", "GuiCTextField")}}">
<label id="LD" style="position:absolute;left:830px;top:20px" lsdata="{1:'FK',3:'x',19:${sid("wnd[0]/usr/txtINT_KNA1-NAME1", "GuiLabel")}}">Becker Berlin</label>
<label id="LV" style="position:absolute;left:600px;top:50px" lsdata="{1:'FV',3:'x',19:${sid("wnd[0]/usr/lblRF02D-VKORG", "GuiLabel")}}">Sales Organization</label>
<input id="FV" style="position:absolute;left:730px;top:50px;width:80px" value="1000" lsdata="{0:'x',20:${sid("wnd[0]/usr/ctxtRF02D-VKORG", "GuiCTextField")}}">
<label id="LT" style="position:absolute;left:830px;top:50px" lsdata="{1:'FV',3:'x',19:${sid("wnd[0]/usr/txtTVKOT-VTEXT", "GuiLabel")}}">Germany Frankfurt</label>

<table id="grid#9" ct="STCS" lsdata="{29:{ColumnIDs:['WERKS','ORT01'],${sid("wnd[0]/usr/cntlRESULT/shell", "GuiGridView").slice(1)}}" style="position:absolute;left:600px;top:100px;width:300px">
  <thead><tr><th lsmatrixrowindex="0" lsmatrixcolindex="1" onclick="window.header='WERKS'" lsdata="{17:${sid("wnd[0]/usr/cntlRESULT/shell/colWERKS", "GuiTableColumn")}}">Plant</th>
    <th lsmatrixrowindex="0" lsmatrixcolindex="2" onclick="window.header='ORT01'" lsdata="{17:${sid("wnd[0]/usr/cntlRESULT/shell/colORT01", "GuiTableColumn")}}">City</th></tr></thead>
  <tbody><tr><td lsmatrixrowindex="1" lsmatrixcolindex="1" ondblclick="window.opened='0001'">0001</td><td lsmatrixrowindex="1" lsmatrixcolindex="2">Walldorf</td></tr></tbody>
</table>

<table id="tree#5" ct="STCS" lsdata="{29:{${sid("wnd[0]/usr/cntlIMAGE/shell", "GuiTree").slice(1, -1)},nodeindexes:[0,['Favo',2,-1],['F00003',1,2]]}}" style="position:absolute;left:600px;top:200px;width:300px">
  <tr iidx="0" dddata="Favo#2#1#1"><td lsmatrixrowindex="0" lsmatrixcolindex="0" subct="HIC" lsdata="{5:'EXPANDED'}"><span ct="TV"></span><span ct="TV" onclick="pickNode(this,'Favo')">Favorites</span></td></tr>
  <tr iidx="1" dddata="F00003#1#2#2"><td lsmatrixrowindex="1" lsmatrixcolindex="0" subct="HIC" lv="1"><span ct="TV"></span><span ct="TV" onclick="pickNode(this,'F00003')">Default Workbook</span></td></tr>
</table>

<table id="menu_1_1" ct="POMN" style="position:absolute;top:500px;left:700px;background:#fff">
  <tr id="u235188" ct="POMNI" onclick="window.chosen='PO'" lsdata="{1:'Purchase\\x20orders',18:${sid("wnd[0]/shellcont/shell/dbtnSELECT/mnu/menu5113NEW:PO_QUERY", "GuiMenu")}}"><td>Purchase orders</td></tr>
  <tr id="u235194" ct="POMNI" onclick="window.chosen='MINE'" lsdata="{1:'My\\x20purchase\\x20orders',18:${sid("wnd[0]/shellcont/shell/dbtnSELECT/mnu/menu5113NEW:POS_BY_USER_QUERY", "GuiMenu")}}"><td>My purchase orders</td></tr>
</table>

<table class="lsField lsField--list"><tr><td><input id="CB1" ct="CB" readonly title="Industry Sector" value="" onclick="document.getElementById('LB1').style.display='block'"
  lsdata="{2:'LB1',20:${sid("wnd[0]/usr/cmbRMMG1-MBRSH", "GuiComboBox")}}"></td></tr></table>
<div id="LB1" ct="LIB_PS" class="lsListbox" style="display:none">
  <div ct="LIB_I" data-itemkey="M" data-itemvalue2="Mechanical Engineering">Mechanical Engineering</div>
  <div ct="LIB_I" data-itemkey="03" data-itemvalue2="Bottleneck Material">Bottleneck Material</div>
</div>

<div ct="PW" id="P1" style="position:absolute;top:700px;left:20px;width:500px" lsdata="{0:'x',5:${sid("wnd[1]", "GuiModalWindow", 1)}}"><span class="urPWTitleText" id="P1-ttltxt">Partner selection</span>
  <table id="userarealist1" ct="AL" lsdata="{4:3,5:1,6:3,10:${sid("wnd[1]/usr", "ABAPLIST", 1)}}"><tr><td>
    <div id="LINE5" ct="ALT" onclick="lineClick('cursor')" lsdata="{2:${sid("wnd[1]/usr/lbl[4,5]", "ABAPLISTTEXT", 1)}}">1000 Becker Berlin</div>
    <div id="LINE6" ct="ALT" onclick="lineClick('mark')" lsdata="{2:${sid("wnd[1]/usr/lbl[4,6]", "ABAPLISTTEXT", 1)}}">1010 Becker Berlin (Versand)</div>
    <div id="LINE7" ct="ALT" lsdata="{2:${sid("wnd[1]/usr/lbl[4,7]", "ABAPLISTTEXT", 1)}}">not marked</div>
  </td></tr></table>

  <table id="u518947" ct="PST" lsdata="{5:true,8:'SH_Page10'}"><tr>
    <td><span id="u518947-tgl" class="lsPnstHdCol lsPnstTglIcon lsPnstTglIconCol" title="Expand" style="display:inline-block;width:16px;height:16px" onclick="openPanel(this)"></span></td>
    <td><div ct="P" id="SH_Page10" lsdata="{8:'Restrictions',25:${sid("wnd[1]/shell/critcol", "GuiSearchHelpPage", 1)}}"><span id="SH_Page10-title">Restrictions</span></div></td></tr>
    <tr id="SH_Page10-cnt" style="display:none"><td colspan="2">
      <label ct="L" id="SH_1800_lbl" f="DDSH[1]LOW[1]" lsdata="{1:'DDSH\\x5b1\\x5dLOW\\x5b1\\x5d',3:'Material\\x20Group'}">Material Group</label>
      <span class="lsField"><input id="DDSH[1]LOW[1]" ct="I" value="" lsdata="{6:true,26:${sid("wnd[1]/shell/critcol/crit1800", "GuiSearchHelpPageItem", 1)}}"></span>
    </td></tr>
  </table>

  <div id="cnt3" ct="CO" lsdata="{5:${sid("wnd[1]/usr/cntlCONTAINER/shellcont/shell", "GuiCalendar", 1)}}">
    <input id="cnt3_if" ct="I" value="16.11.2026" lsdata="{0:'16.11.2026',1:true,2:'DATE',9:'dd.MM.yyyy'}">
    <table id="calendar#cnt3" ct="DN"><tr><td id="cnt3:11:20261116">16</td></tr></table>
  </div>
</div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_TRANSACTION" lsdata="{13:'ZT21'}"></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_DYNPRO" lsdata="{13:'ZCTRL/0200'}"></div>
<script>
  window.posted = [];
  window.oLS = { n: 0, bLocked: function () { return this.n > 0; } };
  function post(what, then) {
    window.oLS.n++;
    window.posted.push(what);
    fetch('/sap/bc/gui/sap/its/webgui/post', { method: 'POST', body: JSON.stringify([{ post: what + '/ses[0]' }]) })
      .then(function () { if (then) then(); window.oLS.n--; });
  }
  // A table control marks the row a moment after the click, in the page.
  function selectLate(td) {
    setTimeout(function () {
      var div = td.firstElementChild;
      var on = /UnSel/.test(div.className);
      div.className = on ? '${SEL}' : '${UNSEL}';
      td.className = on ? 'urSTSC lsSTTDScSel2BgColor' : 'urSTSC';
    }, 350);
  }
  // A list line: Web GUI sends the click 300 ms after the last one. On LINE5 the first request only gives
  // the line the cursor and the next one chooses it; on LINE6 the first one already changes the popup.
  var pending = 0;
  function lineClick(kind) {
    clearTimeout(pending);
    pending = setTimeout(function () {
      post('action/1', function () {
        if (kind === 'mark') { document.getElementById('LINE7').innerText = 'marked'; return; }
        if (!window.cursor) { window.cursor = true; return; }
        document.getElementById('P1').style.display = 'none';
      });
    }, 300);
  }
  // A tree marks the node clicked last on its hierarchy cell.
  function pickNode(span, key) {
    Array.prototype.forEach.call(document.getElementById('tree#5').querySelectorAll('td'), function (td) { td.className = 'urSTC urST3TDHic'; });
    span.parentElement.className = 'urSTC urST3TDHic urST4CellActive urST4Sel2';
    window.node = key;
  }
  function openPanel(tgl) {
    tgl.className = 'lsPnstTglIcon lsPnstHdExp lsPnstTglIconExp';
    document.getElementById('SH_Page10-cnt').style.display = '';
  }
  // The horizontal scrollbar's object, as Web GUI has it: reached only through the event it handles.
  function UCF_Scrollbar() { this.bPixelDirectMode = true; this.iScrollPos = 0; this.iLargeChange = 400; this.iScrollClipping = 500; this.iScrollRange = 1500; }
  UCF_Scrollbar.prototype.onmouseup = function () {};
  UCF_Scrollbar.prototype.iGetFirstVisibleItem = function () { return this.iScrollPos; };
  UCF_Scrollbar.prototype.iGetMaxScrollTo = function () { return this.iScrollRange - this.iScrollClipping + 1; };
  UCF_Scrollbar.prototype.scrollToPosition = function (n) { this.iScrollPos = n; window.scrolls = (window.scrolls || []).concat(n); };
  var hbar = new UCF_Scrollbar();
  document.getElementById('tbl1_hscroll').addEventListener('mouseup', function (e) { hbar.onmouseup(e); });
</script>
</body></html>`;

const refusal = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "",
    (e: unknown) => (e as Error).message,
  );

describe.skipIf(!exe)("Web GUI reader: controls that answer late or hide their parts, in a browser", () => {
  let browser: Browser;
  let page: Page;
  let session: WebGuiSession;
  const fullView = async () => ((await webguiLookInFrame(page.mainFrame(), false)) ?? "").split("\n");
  // The note of the action, without the line that says whether a request went to SAP.
  const act = async (a: Parameters<typeof actRaw>[1]) => (await actRaw(session, a)).split("\n")[0] ?? "";
  const inPage = <T>(expr: string) => page.evaluate(expr) as Promise<T>;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: exe as string, headless: true, args: ["--no-sandbox"] });
  });
  afterAll(async () => {
    await browser?.close();
  });
  async function open(): Promise<void> {
    await page?.context().close();
    page = await (await browser.newContext({ viewport: { width: 1200, height: 1400 } })).newPage();
    await page.route("**/*", async (r) => {
      if (r.request().method() === "POST") {
        await new Promise((x) => setTimeout(x, 100));
        return r.fulfill({ contentType: "text/plain", body: "ok" });
      }
      return r.fulfill({ contentType: "text/html", body: PAGE });
    });
    await page.goto(URL_);
    session = new WebGuiSession(page.mainFrame());
  }

  test("a row that shows its selection 350 ms after the click is waited for: no false \"still not selected\"", async () => {
    await open();
    expect(await act({ do: "select", id: "tblZTC_ITEMS", row: 0 })).toBe("selected row 0 of wnd[0]/usr/tblZTC_ITEMS");
    // A row selected adds to the selection: said, with how to clear one.
    expect(await act({ do: "select", id: "tblZTC_ITEMS", row: 1 })).toBe('selected row 1 of wnd[0]/usr/tblZTC_ITEMS (row 0 is selected too: {"do":"select","id":"wnd[0]/usr/tblZTC_ITEMS","row":N,"value":false} clears one)');
    expect((await fullView()).find((l) => l.startsWith("wnd[0]/usr/tblZTC_ITEMS  table"))).toContain("selected rows 0,1");
    expect(await act({ do: "check", id: "tblZTC_ITEMS", row: 0, value: false })).toBe("deselected row 0 of wnd[0]/usr/tblZTC_ITEMS");
    expect(await act({ do: "select", id: "tblZTC_ITEMS", row: 1 })).toBe("row 1 of wnd[0]/usr/tblZTC_ITEMS was already selected: nothing changed");
  });

  test("a table control scrolls sideways through its pixel scrollbar, to both ends", async () => {
    await open();
    const moved = "scrolled wnd[0]/usr/tblZTC_ITEMS sideways: the view lists the columns on screen now";
    expect(await act({ do: "scroll", id: "tblZTC_ITEMS", to: "left" })).toBe("wnd[0]/usr/tblZTC_ITEMS cannot move further left");
    expect(await act({ do: "scroll", id: "tblZTC_ITEMS", to: "right" })).toBe(moved);
    expect(await act({ do: "scroll", id: "tblZTC_ITEMS", to: "rightmost" })).toBe(moved);
    expect(await act({ do: "scroll", id: "tblZTC_ITEMS", to: "right" })).toBe("wnd[0]/usr/tblZTC_ITEMS cannot move further right");
    expect(await act({ do: "scroll", id: "tblZTC_ITEMS", to: "left" })).toBe(moved);
    expect(await act({ do: "scroll", id: "tblZTC_ITEMS", to: "leftmost" })).toBe(moved);
    expect(await inPage<number[]>("window.scrolls")).toEqual([400, 1001, 601, 0]);
  });

  test("set on a cell of a column scrolled out sideways scrolls to it and types there; no row gets selected (ME21N Plnt, live 2026-11-23)", async () => {
    await open();
    await page.evaluate(() => {
      const t = document.getElementById("tbl1") as HTMLElement;
      t.setAttribute("lsdata", (t.getAttribute("lsdata") ?? "").replace("ColumnIds:['ZV-POSNR']", "ColumnIds:['ZV-POSNR','ZV-WERKS']"));
      const th = document.createElement("th");
      th.setAttribute("lsmatrixrowindex", "0");
      th.setAttribute("lsmatrixcolindex", "2");
      th.setAttribute("lsdata", "{17:{ModalNo:0,SID:'wnd[0]/usr/tblZTC_ITEMS/colZV-WERKS',Type:'GuiTableColumn'}}");
      th.textContent = "Plnt";
      t.querySelector("tr")?.appendChild(th);
      // Ctrl+A in a cell of a table control selects all its rows, as in Web GUI.
      t.addEventListener("keydown", (e) => {
        if (e.key.toLowerCase() === "a" && (e.ctrlKey || e.metaKey))
          t.querySelectorAll("td[subct='SC']").forEach((td) => {
            td.className = "urSTSC lsSTTDScSel2BgColor";
            (td.firstElementChild as HTMLElement).className = "urBorderBox urSTSCOuterDiv urSTRowSelSecIcon urST4LbSelIcon";
          });
      });
      // The bar draws the Plant cells once the table has moved right, and hides the Item cells.
      const w = window as unknown as { UCF_Scrollbar: { prototype: { scrollToPosition: (n: number) => void; iScrollPos: number } } };
      const orig = w.UCF_Scrollbar.prototype.scrollToPosition;
      w.UCF_Scrollbar.prototype.scrollToPosition = function (n: number) {
        orig.call(this, n);
        if (n <= 0 || document.getElementById("PLANT0")) return;
        t.querySelectorAll("tr").forEach((tr, i) => {
          if (i === 0) return;
          tr.querySelector("input")?.closest("td")?.remove();
          const td = document.createElement("td");
          td.innerHTML = `<input id="PLANT${i - 1}" value="" lsdata="{0:'x',20:{ModalNo:0,SID:'wnd[0]/usr/tblZTC_ITEMS/ctxtZV-WERKS[1,${i - 1}]',Type:'GuiCTextField'}}">`;
          tr.appendChild(td);
        });
      };
    });
    expect(await act({ do: "set", id: "tblZTC_ITEMS", row: 0, col: "Plnt", value: "1000" })).toBe("set wnd[0]/usr/tblZTC_ITEMS/ctxtZV-WERKS[1,0] (row 0, column Plnt of wnd[0]/usr/tblZTC_ITEMS) (scrolled sideways to the column)");
    expect(await page.locator("#PLANT0").inputValue()).toBe("1000");
    expect((await fullView()).find((l) => l.startsWith("wnd[0]/usr/tblZTC_ITEMS  table"))).not.toContain("selected rows");
  });

  test("the rows of a dropdown button's menu are named by their scripting id, judged and pressed", async () => {
    await open();
    const mine = "wnd[0]/shellcont/shell/dbtnSELECT/mnu/menu5113NEW:POS_BY_USER_QUERY";
    const full = await fullView();
    expect(full).toContain(`${mine}  menu  My purchase orders`);
    expect(full.some((l) => l.startsWith("u2351"))).toBe(false);
    // The guard knows the row: it is judged by its text, not refused as "no control".
    expect((await webguiAssessInFrame(page.mainFrame(), { do: "press", id: "menu5113NEW:POS_BY_USER_QUERY" })).reason).not.toContain("not on the screen");
    expect(await act({ do: "press", id: "menu5113NEW:POS_BY_USER_QUERY" })).toBe(`chose menu entry ${mine}`);
    expect(await inPage<string>("window.chosen")).toBe("MINE");
    expect(await act({ do: "select", id: "wnd[0]/shellcont/shell/dbtnSELECT/mnu/menu5113NEW:PO_QUERY" })).toBe("chose menu entry wnd[0]/shellcont/shell/dbtnSELECT/mnu/menu5113NEW:PO_QUERY");
    expect(await inPage<string>("window.chosen")).toBe("PO");
  });

  test("a field is named by its own label; the text after it is the description of its value", async () => {
    await open();
    const full = await fullView();
    // "Customer" points at the search button before the field, and the customer's name at the field.
    expect(full).toContain('wnd[0]/usr/ctxtRF02D-KUNNR  field  Customer = "1000" Becker Berlin  (edit)');
    expect(full).toContain('wnd[0]/usr/ctxtRF02D-VKORG  field  Sales Organization = "1000" Germany Frankfurt  (edit)');
  });

  test("a grid column the grid does not have is refused; a column without a row is selected by its header", async () => {
    await open();
    expect(await refusal(actRaw(session, { do: "grid", id: "cntlRESULT/shell", row: 0, col: "NOPE", how: "double" }))).toBe("no column NOPE in wnd[0]/usr/cntlRESULT/shell: its columns are WERKS, ORT01");
    expect(await inPage<string | undefined>("window.opened")).toBeUndefined();
    expect(await act({ do: "grid", id: "cntlRESULT/shell", col: "ORT01", how: "select" })).toBe("grid selected column ORT01");
    expect(await inPage<string>("window.header")).toBe("ORT01");
    expect(await act({ do: "grid", id: "cntlRESULT/shell", row: 0, col: "WERKS", how: "double" })).toBe("grid double row 0 column WERKS");
    expect(await inPage<string>("window.opened")).toBe("0001");
  });

  test("a tree node is clicked on its text, not on the empty element before it, and the view marks it", async () => {
    await open();
    const t0 = Date.now();
    expect(await act({ do: "tree", id: "cntlIMAGE/shell", node: "F00003", how: "select" })).toBe("tree select F00003");
    // The click on the element without a size waited 5 s.
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(await inPage<string>("window.node")).toBe("F00003");
    const full = await fullView();
    expect(full).toContain("    Default Workbook (selected)  {node F00003}");
    expect(full).toContain("  [-] Favorites  {node Favo}");
  });

  test("a wrong dropdown key is answered with the entries as the list writes them", async () => {
    await open();
    expect(await refusal(actRaw(session, { do: "combo", id: "cmbRMMG1-MBRSH", key: "ZZ" }))).toBe('no entry "ZZ" in wnd[0]/usr/cmbRMMG1-MBRSH: give an entry\'s key exactly ("" for the blank entry, which clears the field). Its entries (key:text): M:Mechanical Engineering, 03:Bottleneck Material');
  });

  test("a double-click on a popup's list line that only gave it the cursor is made once more, after its late request", async () => {
    await open();
    expect(await act({ do: "dblclick", id: "wnd[1]/usr/lbl[4,5]" })).toBe("double-clicked wnd[1]/usr/lbl[4,5] (twice: the first double-click only gave the list the cursor)");
    expect(await inPage<string[]>("window.posted")).toEqual(["action/1", "action/1"]);
    expect(await inPage<string>("document.getElementById('P1').style.display")).toBe("none");
  });

  test("a double-click that changed the popup is not made again", async () => {
    await open();
    expect(await act({ do: "dblclick", id: "wnd[1]/usr/lbl[4,6]" })).toBe("double-clicked wnd[1]/usr/lbl[4,6]");
    expect(await inPage<string[]>("window.posted")).toEqual(["action/1"]);
    expect(await fullView()).toContain("wnd[1]/usr/lbl[4,7]  label  marked");
  });

  test("the restrictions of a value help: closed, opened by select, then its fields are read and typed into", async () => {
    await open();
    expect(await fullView()).toContain('wnd[1]/shell/critcol  tab  Restrictions  (closed: "select" opens it and shows its fields)');
    expect((await fullView()).some((l) => l.includes("crit1800"))).toBe(false);
    expect(await act({ do: "select", id: "critcol" })).toBe("selected wnd[1]/shell/critcol");
    const full = await fullView();
    expect(full).toContain("wnd[1]/shell/critcol  tab  Restrictions (selected)");
    expect(full).toContain('wnd[1]/shell/critcol/crit1800  field  Material Group = ""  (edit)');
    expect(await act({ do: "set", id: "crit1800", value: "001*" })).toBe("set wnd[1]/shell/critcol/crit1800");
    expect(await fullView()).toContain('wnd[1]/shell/critcol/crit1800  field  Material Group = "001*"  (edit)');
  });

  test("a calendar shows the date it holds as a field, and set types the date into it", async () => {
    await open();
    const cal = "wnd[1]/usr/cntlCONTAINER/shellcont/shell";
    expect(await fullView()).toContain(`${cal}  field  Date = "16.11.2026"  (edit)  calendar (dd.MM.yyyy): "set" the date here, then Continue copies it to the field`);
    expect(await act({ do: "set", id: cal, value: "24.12.2026" })).toBe(`set ${cal}`);
    expect(await inPage<string>("document.getElementById('cnt3_if').value")).toBe("24.12.2026");
    expect((await fullView()).find((l) => l.startsWith(cal))).toContain('Date = "24.12.2026"');
  });
});

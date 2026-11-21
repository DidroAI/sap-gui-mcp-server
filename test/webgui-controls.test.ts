/**
 * The Web GUI reader on controls whose state Web GUI draws in its own way,
 * on a page built from small snippets of real Web GUI markup (ECC, SAP GUI
 * for HTML, saved on 2026-11-15; values made up, no SAP data):
 *
 * - a dropdown is an <input readonly> by construction; it is read-only only
 *   when its frame says so (lsField--readonly);
 * - checkboxes and radio buttons show their state in their class; the hidden
 *   input inside keeps what the server drew; a greyed one has --disabled;
 * - a row selector cell (subct SC) shows a selected row with a "Sel" icon;
 * - a toolbar moves the buttons it cannot show behind ">>" (lsToolbar--item-hidden);
 *   its menu entries are rows named <button DOM id>-BtnMenu;
 * - a closed menu stays in the page, moved far above the window;
 * - a list checkbox shows an image (urCImgOn / urCImgOff), a list icon its tooltip;
 * - a tree without a column header has its first node in row 0.
 *
 * The page's scripts stand in for Web GUI's: a click opens a list, chooses an
 * entry, toggles a row selector. Needs a Chrome: SAP_TEST_CHROME=/path/to/chrome.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Driver } from "../src/core/types.js";
import { webguiActInFrame, webguiLookInFrame } from "../src/webgui/index.js";
import { view } from "../src/webgui/reader.js";
import { WebGuiSession } from "../src/webgui/session.js";

const exe = process.env.SAP_TEST_CHROME;
const sid = (id: string, type: string, modal = 0) => `{ModalNo:0,SID:'${id}',Type:'${type}'${modal ? "" : ""}}`;
const SEL = "urBorderBox lsSTCellHeight100 urSTSCOuterDiv urSTRowSelSecIcon urST4LbSelIcon";
const UNSEL = "urBorderBox lsSTCellHeight100 urSTSCOuterDiv urSTRowUnSelIcon urST4LbUnselIcon";
const sc = (id: string, r: number, on: boolean) =>
  `<td id="${id}[${r},0]" subct="SC" lsmatrixrowindex="${r}" lsmatrixcolindex="0" class="urSTSC${on ? " lsSTTDScSel2BgColor" : ""}" onclick="toggleRow(this)"><div class="${on ? SEL : UNSEL}">&nbsp;</div></td>`;
const input = (dom: string, id: string, type: string, value: string, ro: boolean) =>
  `<span class="lsField lsField--table${ro ? " lsField--readonly" : ""}"><input id="${dom}" value="${value}"${ro ? " readonly" : ""} lsdata="{0:'FREETEXT',20:${sid(id, type)}}"></span>`;

const PAGE = `<!doctype html><html lang="en"><head><title>Synthetic</title></head><body>
<div id="cuaheader" lsdata="{1:'Synthetic\\x20controls'}">Synthetic controls</div>
<input id="ToolbarOkCode" lsdata="{0:'FREETEXT',20:${sid("wnd[0]/tbar[0]/okcd", "GuiOKCodeField")}}">
<div id="u1" ct="T" class="lsToolbar lsToolbar--standards-overflow" style="width:400px">
  <div id="u1-itms">
    <span class="lsToolbar--item"><div id="M0:37::btn[5]" ct="B" title="Flow (F5)" lsdata="{0:'Flow',4:'Flow',19:'F5',28:${sid("wnd[0]/tbar[1]/btn[5]", "GuiButton")}}">Flow</div></span>
    <span id="M0:37::btn[7]-r" class="lsToolbar--item lsToolbar--item-hidden" style="display:none"><div id="M0:37::btn[7]" ct="B" title="Orders (F7)" lsdata="{0:'Orders',4:'List\\x20of\\x20orders',19:'F7',28:${sid("wnd[0]/tbar[1]/btn[7]", "GuiButton")}}">Orders</div></span>
  </div>
  <div id="u1-hiddenOpener" title="More" style="display:inline-block;width:20px;height:20px" onclick="document.getElementById('OVM').style.top='60px'">&gt;&gt;</div>
</div>
<table id="OVM" style="position:absolute;top:-9999px;left:300px;background:#fff"><tr id="M0:37::btn[7]-BtnMenu" ct="POMNI" onclick="window.pressedOverflow=(window.pressedOverflow||0)+1;document.getElementById('OVM').style.top='-9999px'"><td>Orders (F7)</td></tr></table>
<table id="CLOSED" style="position:absolute;top:-9998px;left:27px"><tr id="u60580" ct="POMNI"><td>My purchase orders</td></tr></table>

<table class="lsField lsField--list"><tr><td><input id="CB1" ct="CB" readonly title="Industry Sector" value="" onclick="document.getElementById('LB1').style.display='block'"
  lsdata="{2:'RMMG1\\x2dMBRSHSAPLMGMM',20:${sid("wnd[0]/usr/cmbRMMG1-MBRSH", "GuiComboBox")}}"></td></tr></table>
<div id="RMMG1-MBRSHSAPLMGMM" ct="LIB_PS" class="lsListbox" style="display:none">
  <div ct="LIB_I" data-itemkey="2" data-itemvalue2="Aerospace" onclick="pick('CB1','LB1',this)">Aerospace</div>
  <div ct="LIB_I" data-itemkey="B" data-itemvalue2="Beverage" onclick="pick('CB1','LB1',this)">Beverage</div>
</div>
<div id="LB2" ct="LIB_PS" class="lsListbox"><div ct="LIB_I" data-itemkey="X" onclick="pick('CB1','LB2',this)">Beverage</div></div>
<table class="lsField lsField--readonly lsField--list"><tr><td><input id="CB2" ct="CB" readonly title="Delivery block" value=""
  lsdata="{2:'VBAK\\x2dLIFSKSAPMV45A',20:${sid("wnd[0]/usr/cmbVBAK-LIFSK", "GuiComboBox")}}"></td></tr></table>

<span ct="R_standards" id="R1" class="lsRadioButton--unchecked" lsdata="{4:'Storage\\x20stock',13:${sid("wnd[0]/usr/radLGBST", "GuiRadioButton")}}"><input type="checkbox" checked><span>Storage stock</span></span>
<span ct="R_standards" id="R2" class="lsRadioButton--checked" lsdata="{4:'Special\\x20stock',13:${sid("wnd[0]/usr/radSBBST", "GuiRadioButton")}}"><input type="checkbox"><span>Special stock</span></span>
<span ct="C_standards" id="C1" class="lsCheckBox--unchecked--disabled" lsdata="{4:'Assign\\x20values',15:${sid("wnd[0]/usr/chkMARA-KZEFF", "GuiCheckBox")}}"><input type="checkbox"><span>Assign values</span></span>
<span ct="C_standards" id="C2" class="lsCheckBox--checked" onclick="this.className='lsCheckBox--checked'" lsdata="{4:'Cash\\x20discount',15:${sid("wnd[0]/usr/chkMVKE-SKTOF", "GuiCheckBox")}}"><input type="checkbox" checked><span>Cash discount</span></span>
<span ct="C_standards" id="C3" class="lsCheckBox--unchecked" onclick="this.className=/--unchecked/.test(this.className)?'lsCheckBox--checked':'lsCheckBox--unchecked'" lsdata="{4:'Totals\\x20only',15:${sid("wnd[0]/usr/chkXSUM", "GuiCheckBox")}}"><input type="checkbox"><span>Totals only</span></span>

<table id="tbl1" ct="STCS" lsdata="{10:'MULTI',29:{ColumnIds:['ZV-POSNR','ZV-MATNR','ZV-ABGRU'],${sid("wnd[0]/usr/tblZTC_ITEMS", "GuiTableControl").slice(1)}}" style="width:600px">
  <tr><th lsmatrixrowindex="0" lsmatrixcolindex="1" lsdata="{17:${sid("wnd[0]/usr/tblZTC_ITEMS/colZV-POSNR", "GuiTableColumn")}}">Item</th>
      <th lsmatrixrowindex="0" lsmatrixcolindex="2" lsdata="{17:${sid("wnd[0]/usr/tblZTC_ITEMS/colZV-MATNR", "GuiTableColumn")}}">Material</th>
      <th lsmatrixrowindex="0" lsmatrixcolindex="3" lsdata="{17:${sid("wnd[0]/usr/tblZTC_ITEMS/colZV-ABGRU", "GuiTableColumn")}}">Reason</th></tr>
  <tr>${sc("tbl1", 1, false)}<td>${input("T1", "wnd[0]/usr/tblZTC_ITEMS/txtZV-POSNR[0,0]", "GuiTextField", "10", true)}</td><td>${input("T2", "wnd[0]/usr/tblZTC_ITEMS/ctxtZV-MATNR[1,0]", "GuiCTextField", "M-17", true)}</td>
    <td><table class="lsField lsField--list"><tr><td><input id="T3" ct="CB" readonly value="" lsdata="{2:'LBX',20:${sid("wnd[0]/usr/tblZTC_ITEMS/cmbZV-ABGRU[2,0]", "GuiComboBox")}}"></td></tr></table></td></tr>
  <tr>${sc("tbl1", 2, true)}<td>${input("T4", "wnd[0]/usr/tblZTC_ITEMS/txtZV-POSNR[0,1]", "GuiTextField", "20", true)}</td><td>${input("T5", "wnd[0]/usr/tblZTC_ITEMS/ctxtZV-MATNR[1,1]", "GuiCTextField", "M-18", true)}</td><td></td></tr>
  <tr>${sc("tbl1", 3, false)}<td>${input("T6", "wnd[0]/usr/tblZTC_ITEMS/txtZV-POSNR[0,2]", "GuiTextField", "", false)}</td><td>${input("T7", "wnd[0]/usr/tblZTC_ITEMS/ctxtZV-MATNR[1,2]", "GuiCTextField", "", false)}</td><td></td></tr>
</table>
<div id="tbl1-vscroll" ct="SCB" style="width:16px;height:60px" lsdata="{0:1,1:1,3:3,6:'tbl1',10:3}">&nbsp;</div>

<table id="grid#9" ct="STCS" lsdata="{29:{ColumnIDs:['FIELD','UP'],${sid("wnd[0]/usr/cntlSORT/shell", "GuiGridView").slice(1)}}" style="width:600px">
  <thead><tr><th colspan="3"><div ct="T" lsdata="{10:${sid("wnd[0]/usr/cntlSORT/shell/tbar", "GuiControlToolBar")}}">
    <div ct="B" title="Details" lsdata="{4:'Details',28:${sid("wnd[0]/usr/cntlSORT/shell/tbar/btn&DETAIL", "GuiButton")}}">D</div></div></th></tr>
  <tr><th lsmatrixrowindex="0" lsmatrixcolindex="1" lsdata="{17:${sid("wnd[0]/usr/cntlSORT/shell/colFIELD", "GuiTableColumn")}}">Field</th><th lsmatrixrowindex="0" lsmatrixcolindex="2" lsdata="{17:${sid("wnd[0]/usr/cntlSORT/shell/colUP", "GuiTableColumn")}}">Up</th></tr></thead>
  <tbody>
  <tr>${sc("grid#9#", 1, false)}<td lsmatrixrowindex="1" lsmatrixcolindex="1">Net value</td><td lsmatrixrowindex="1" lsmatrixcolindex="2"><span ct="R_standards" class="lsRadioButton--unchecked"><input type="checkbox" value="on"></span></td></tr>
  <tr>${sc("grid#9#", 2, true)}<td lsmatrixrowindex="2" lsmatrixcolindex="1">Vendor</td><td lsmatrixrowindex="2" lsmatrixcolindex="2"><span ct="R_standards" class="lsRadioButton--checked"><input type="checkbox" value="on"></span></td></tr>
  </tbody>
</table>

<table id="tree#5" ct="STCS" lsdata="{29:{${sid("wnd[0]/usr/cntlIMAGE/shell", "GuiTree").slice(1, -1)},nodeindexes:[0,['Favo',2,-1],['Root',0,-1],['42',1,2],['43',1,2]]}}" style="width:600px">
  <tr iidx="0" dddata="Favo#2#1#1"><td lsmatrixrowindex="0" lsmatrixcolindex="0" subct="HIC" lsdata="{5:'EXPANDED'}">Favorites</td></tr>
  <tr iidx="1"><td lsmatrixrowindex="1" lsmatrixcolindex="0" subct="HIC" lsdata="{5:'EXPANDED'}">SAP Menu</td></tr>
  <tr iidx="2" dddata="42#1#2#3"><td lsmatrixrowindex="2" lsmatrixcolindex="0" subct="HIC" lv="1" lsdata="{5:'COLLAPSED'}"><span ct="TV" onclick="window.clickedNode='Logistics'">Logistics</span></td></tr>
  <tr iidx="3" dddata="43#1#2#4"><td lsmatrixrowindex="3" lsmatrixcolindex="0" subct="HIC" lv="1" lsdata="{5:'COLLAPSED'}"><span ct="TV" onclick="window.clickedNode='Accounting'">Accounting</span></td></tr>
  <tr iidx="4"><td lsmatrixrowindex="4" lsmatrixcolindex="0" subct="HIC">&nbsp;</td></tr>
</table>

<table id="tree#6" ct="STCS" lsdata="{29:{${sid("wnd[0]/usr/cntlSTOCK/shell", "GuiTree").slice(1, -1)},nodeindexes:[0,['1',0,-1]]}}" style="width:600px">
  <tr><th lsmatrixcolindex="0">Plant</th><th lsmatrixcolindex="1">Unrestricted</th><th lsmatrixcolindex="2">Quality</th><th lsmatrixcolindex="3">Reserved</th></tr>
  <tr iidx="0" dddata="1#0"><td lsmatrixrowindex="1" lsmatrixcolindex="0" subct="HIC">Dresden</td><td lsmatrixrowindex="1" lsmatrixcolindex="1">1,000</td><td lsmatrixrowindex="1" lsmatrixcolindex="2"></td><td lsmatrixrowindex="1" lsmatrixcolindex="3">100,000</td></tr>
</table>

<table id="userarealist0" ct="AL" lsdata="{4:2,5:1,6:2,10:${sid("wnd[0]/usr", "ABAPLIST")}}"><tr><td>
  <div ct="ALC" lsdata="{3:${sid("wnd[0]/usr/chk[1,1]", "ABAPLISTCHECKBOX")}}" class="lsAbapList__checkbox lsAbapList__item--selection"><img class="lsCImgDspl urCImgOn"><span class="lsCBImgSymb lsCBImgSel"></span></div>
  <div ct="ALI" title="Cleared" lsdata="{1:${sid("wnd[0]/usr/lbl[6,1]", "ABAPLISTIMAGE")}}"><img src="x.png" style="width:16px;height:16px"></div>
  <div ct="ALT" lsdata="{2:${sid("wnd[0]/usr/lbl[11,1]", "ABAPLISTTEXT")}}">RV</div>
  <div ct="ALC" lsdata="{3:${sid("wnd[0]/usr/chk[1,2]", "ABAPLISTCHECKBOX")}}" class="lsAbapList__checkbox"><img class="lsCImgDspl urCImgOff"><span class="lsCBImgSymb"></span></div>
  <div ct="ALT" lsdata="{2:${sid("wnd[0]/usr/lbl[11,2]", "ABAPLISTTEXT")}}">DZ</div>
</td></tr></table>
<div id="msgarea"><span ct="TV">XYZ (100)</span></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_TRANSACTION" lsdata="{13:'ZT20'}"></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_DYNPRO" lsdata="{13:'ZCTRL/0100'}"></div>
<script>
  function pick(inputId, listId, item) {
    document.getElementById(inputId).value = item.innerText;
    item.parentElement.style.display = 'none';
  }
  function toggleRow(td) {
    var div = td.firstElementChild;
    var on = /UnSel/.test(div.className);
    div.className = on ? '${SEL}' : '${UNSEL}';
    td.className = on ? 'urSTSC lsSTTDScSel2BgColor' : 'urSTSC';
  }
  // The list box id of CB1 is its lsdata key 2; LB1 is the same element.
  document.getElementById('RMMG1-MBRSHSAPLMGMM').id = 'RMMG1-MBRSHSAPLMGMM';
  window.LB1 = document.getElementById('RMMG1-MBRSHSAPLMGMM');
  document.getElementById('CB1').onclick = function () { document.getElementById('RMMG1-MBRSHSAPLMGMM').style.display = 'block'; };
  Array.prototype.forEach.call(document.querySelectorAll('#RMMG1-MBRSHSAPLMGMM [ct=LIB_I]'), function (it) { it.onclick = function () { document.getElementById('CB1').value = it.innerText; it.parentElement.style.display = 'none'; }; });
</script>
</body></html>`;

const refusal = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "",
    (e: unknown) => (e as Error).message,
  );

describe.skipIf(!exe)("Web GUI reader: control states as Web GUI draws them, in a browser", () => {
  let browser: Browser;
  let page: Page;
  const fullView = async () => ((await webguiLookInFrame(page.mainFrame(), false)) ?? "").split("\n");
  const compactView = async () => ((await webguiLookInFrame(page.mainFrame(), true)) ?? "").split("\n");
  const look: Driver["look"] = (options) => view(new WebGuiSession(page.mainFrame()), options);
  const actRaw = (a: Parameters<typeof webguiActInFrame>[1]) => webguiActInFrame(page.mainFrame(), a);
  // The test page never sends a request to SAP, so every answer ends with the
  // "Nothing was sent to SAP" or "(Set in the page…)" line; these tests read the note before it.
  const NOTHING_SENT = /\n(?:Nothing was sent to SAP for this action|\(Set in the page: SAP gets it)[^\n]*$/;
  const act = async (a: Parameters<typeof webguiActInFrame>[1]) => (await actRaw(a)).replace(NOTHING_SENT, "");
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: exe!, headless: true, args: ["--no-sandbox"] });
    page = await browser.newPage({ viewport: { width: 1200, height: 1400 } });
    await page.setContent(PAGE);
  });
  afterAll(async () => {
    await browser?.close();
  });

  test("a dropdown is read-only only when its frame says so, and the view says which", async () => {
    const full = await fullView();
    expect(full).toContain('wnd[0]/usr/cmbRMMG1-MBRSH  dropdown  Industry Sector = ""   (edit)  2 options: 2:Aerospace, B:Beverage');
    expect(full).toContain('wnd[0]/usr/cmbVBAK-LIFSK  dropdown  Delivery block = ""   (read-only)');
    expect(await refusal(act({ do: "combo", id: "cmbVBAK-LIFSK", key: "01" }))).toContain("is read-only");
  });

  test("combo chooses from the dropdown's own list, by key or text, and answers what the field shows", async () => {
    expect(await act({ do: "combo", id: "cmbRMMG1-MBRSH", key: "B" })).toBe("wnd[0]/usr/cmbRMMG1-MBRSH = B Beverage");
    expect(await page.locator("#CB1").inputValue()).toBe("Beverage");
    // The view shows the entry chosen in the page, with its key, before the server draws it again.
    expect(await fullView()).toContain('wnd[0]/usr/cmbRMMG1-MBRSH  dropdown  Industry Sector = "B" Beverage  (edit)  2 options: 2:Aerospace, B:Beverage');
    expect(await act({ do: "set", id: "cmbRMMG1-MBRSH", value: "Aerospace" })).toBe("wnd[0]/usr/cmbRMMG1-MBRSH = 2 Aerospace");
  });

  test("a radio button's state comes from its class, not from the input the server drew", async () => {
    const full = await fullView();
    expect(full).toContain("wnd[0]/usr/radLGBST  radio  [ ] Storage stock");
    expect(full).toContain("wnd[0]/usr/radSBBST  radio  [x] Special stock");
  });

  test("check: refused on a greyed box, says so when nothing changes, and when SAP puts the box back", async () => {
    expect(await fullView()).toContain("wnd[0]/usr/chkMARA-KZEFF  checkbox  [ ] Assign values  (read-only)");
    expect(await refusal(act({ do: "check", id: "chkMARA-KZEFF", value: true }))).toContain("greyed out (read-only)");
    expect(await act({ do: "check", id: "chkXSUM", value: false })).toBe("wnd[0]/usr/chkXSUM was already unchecked: nothing changed");
    expect(await act({ do: "check", id: "chkXSUM", value: true })).toBe("wnd[0]/usr/chkXSUM checked");
    expect(await fullView()).toContain("wnd[0]/usr/chkXSUM  checkbox  [x] Totals only");
    // This box goes back to checked on every click (as SAP does with one it sets itself).
    expect(await refusal(act({ do: "check", id: "chkMVKE-SKTOF", value: false }))).toContain("is still checked");
  });

  test("a table control says which rows are selected; select and check with a row work its row selector", async () => {
    const full = await fullView();
    expect(full).toContain("wnd[0]/usr/tblZTC_ITEMS  table  rows 3 (visible 3); rows can be selected; selected rows 1; columns: Item | Material | Reason");
    const c = await compactView();
    expect(c).toContain("  row 1 (selected): Item=20; Material=M-18");
    expect(await act({ do: "select", id: "tblZTC_ITEMS", row: 0 })).toBe("selected row 0 of wnd[0]/usr/tblZTC_ITEMS");
    expect(await act({ do: "select", id: "tblZTC_ITEMS", row: 0 })).toBe("row 0 of wnd[0]/usr/tblZTC_ITEMS was already selected: nothing changed");
    expect(await act({ do: "check", id: "tblZTC_ITEMS", row: 1, value: false })).toBe("deselected row 1 of wnd[0]/usr/tblZTC_ITEMS");
    expect(await fullView()).toContain("wnd[0]/usr/tblZTC_ITEMS  table  rows 3 (visible 3); rows can be selected; selected rows 0; columns: Item | Material | Reason");
    expect(await refusal(act({ do: "select", id: "tblZTC_ITEMS", row: 7 }))).toContain("row 7 is not on screen");
  });

  test("one control by id: a table whose last cell is a dropdown is a table", async () => {
    const block = await look({ compact: false, id: "tblZTC_ITEMS" });
    expect(block).toContain("wnd[0]/usr/tblZTC_ITEMS  table");
    expect(block).toContain("wnd[0]/usr/tblZTC_ITEMS/cmbZV-ABGRU[2,0]  dropdown");
  });

  test("a grid: selected rows marked, radio cells by their state, its own toolbar listed", async () => {
    const full = await fullView();
    expect(full).toContain("wnd[0]/usr/cntlSORT/shell  grid  2 rows; rows can be selected; columns: FIELD=Field | UP=Up");
    expect(full).toContain("  row 0: Net value | ");
    expect(full).toContain("  row 1 (selected): Vendor | X");
    expect(full).toContain("wnd[0]/usr/cntlSORT/shell/tbar/btn&DETAIL  button  Details");
    expect(await act({ do: "grid", id: "cntlSORT/shell", row: 0, how: "select" })).toBe("selected row 0 of wnd[0]/usr/cntlSORT/shell");
    expect(await fullView()).toContain("  row 0 (selected): Net value | ");
  });

  test("a toolbar button behind >> is listed and pressed through the >> menu", async () => {
    expect(await fullView()).toContain('wnd[0]/tbar[1]/btn[7]  button  Orders (F7)  (behind ">>")');
    expect(await act({ do: "press", id: "btn[7]" })).toBe('pressed wnd[0]/tbar[1]/btn[7] (from the ">>" menu of its toolbar)');
    expect(await page.evaluate(() => (window as unknown as { pressedOverflow?: number }).pressedOverflow)).toBe(1);
  });

  test("a closed menu, moved above the window, is not in the view", async () => {
    expect((await fullView()).some((l) => l.includes("My purchase orders"))).toBe(false);
  });

  test("a list checkbox and a list icon", async () => {
    const full = await fullView();
    expect(full).toContain("wnd[0]/usr/chk[1,1]  checkbox  [x] ");
    expect(full).toContain("wnd[0]/usr/chk[1,2]  checkbox  [ ] ");
    expect(full).toContain('wnd[0]/usr/lbl[6,1]  label  icon "Cleared"');
  });

  test("a tree without a column header: its first node is read, no ghost lines, and a node is found by its own row", async () => {
    const full = await fullView();
    const at = full.findIndex((l) => l.startsWith("wnd[0]/usr/cntlIMAGE/shell  tree"));
    expect(full.slice(at, at + 5)).toEqual([
      "wnd[0]/usr/cntlIMAGE/shell  tree  4 nodes shown",
      "  [-] Favorites  {node Favo}",
      "  [-] SAP Menu  {node Root}",
      "    [+] Logistics  {node 42}",
      "    [+] Accounting  {node 43}",
    ]);
    await act({ do: "tree", id: "cntlIMAGE/shell", node: "42", how: "select" });
    expect(await page.evaluate(() => (window as unknown as { clickedNode?: string }).clickedNode)).toBe("Logistics");
    expect(await act({ do: "tree", id: "cntlIMAGE/shell", node: "Root", how: "expand" })).toBe("node Root is already expanded: nothing changed");
  });

  test("a tree with columns keeps each value under its column, empty ones too", async () => {
    expect(await fullView()).toContain("  Dresden | 1,000 |  | 100,000  {node 1}");
  });
});

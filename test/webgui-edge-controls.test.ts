/**
 * The Web GUI reader on the odd cases of the edge-case bench (round 3,
 * ECCSCR), on a page built from small snippets of real Web GUI markup (ECC,
 * saved on 2026-11-16; values made up, no SAP data). Each test says which
 * case it stands for. Needs a Chrome: SAP_TEST_CHROME=/path/to/chrome.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { compact } from "../src/core/compact.js";
import { webguiActInFrame, webguiLookInFrame } from "../src/webgui/index.js";
import { coveredBy, view } from "../src/webgui/reader.js";
import { menuLines } from "../src/webgui/screen.js";
import { WebGuiSession } from "../src/webgui/session.js";

const exe = process.env.SAP_TEST_CHROME;
const sid = (id: string, type: string, modal = 0) => `{ModalNo:${modal},SID:'${id}',Type:'${type}'}`;

const HEAD = `<div id="cuaheader" lsdata="{1:'Synthetic\\x20edge\\x20cases'}">Synthetic edge cases</div>
<input id="ToolbarOkCode" lsdata="{0:'FREETEXT',20:${sid("wnd[0]/tbar[0]/okcd", "GuiOKCodeField")}}">`;

const FIELDS = `
<input id="F1" title="Order Type" maxlength="4" value="" lsdata="{0:'x',20:${sid("wnd[0]/usr/ctxtZHDR-TYPE", "GuiCTextField")}}">
<input id="F2" title="Name" value="" lsdata="{0:'x',20:${sid("wnd[0]/usr/txtZHDR-NAME", "GuiTextField")}}" onkeydown="if(event.key==='Enter')window.entered=(window.entered||0)+1">
<textarea id="TE1" ct="TE" rows="4" cols="40" onkeydown="if(event.key==='Enter')window.entered=(window.entered||0)+1" lsdata="{17:true,19:${sid("wnd[0]/usr/cntlTEXT/shellcont/shell", "GuiTextEdit")}}"></textarea>`;

// MB51 after "Not equal to" was chosen for Material: the operator is an icon label before the field.
const SELOPT = `
<label id="SL1" f="SF1" lsdata="{1:'SF1',3:'Material',19:${sid("wnd[0]/usr/txt%_MATNR_%_APP_%-TEXT", "GuiLabel")}}">Material</label>
<span ct="L" id="SI1" title="Select: Not equal to" tabindex="0" style="display:inline-block;width:16px;height:16px" lsdata="{0:'Select\\x3a\\x20Not\\x20equal\\x20to',8:true,19:${sid("wnd[0]/usr/txt%_MATNR_%_APP_%-OPTI_PUSH", "GuiLabel")}}"></span>
<input id="SF1" value="M-17" lsdata="{0:'x',20:${sid("wnd[0]/usr/ctxtMATNR-LOW", "GuiCTextField")}}">`;

// F1 help (Performance Assistant): headings, paragraphs with links, a small table.
const HELP = `<iframe id="V1" style="width:500px;height:200px" lsdata="{0:'x',20:${sid("wnd[0]/usr/cntlHELP/shellcont/shell", "GuiHtmlViewer")}}"
  srcdoc="<h3>Sales Document Type</h3><p>A classification that distinguishes between different types of <a href='#e2'><b>sales document</b></a>.</p><h3>Use</h3><p>${"The type decides the screens that follow. ".repeat(60)}</p><table><tr><th>Sales document type</th><th>Parameter ID</th></tr><tr><td>Order</td><td>AAT</td></tr></table><a href='#x'>Glossary</a><button>Close</button>"></iframe>`;

// An editable ALV grid (BCALV_EDIT_03) with a title, a selected column, a sorted and a filtered column, and a totals row.
const G = "wnd[0]/usr/cntlGRID/shellcont/shell";
const th = (c: number, id: string, title: string, cls = "urST3HUnsel", icon = "") =>
  `<th id="grid#9#0,${c}" lsmatrixrowindex="0" lsmatrixcolindex="${c}" class="urSTHC ${cls}" lsdata="{7:'${title}',17:${sid(`${G}/col${id}`, "GuiTableColumn")}}">${title}${icon ? `<img id="grid#9#0,${c}-HCICO" src="/its/images/gridview/${icon}.png">` : ""}</th>`;
const td = (r: number, c: number, text: string, extra = "") =>
  `<td id="grid#9#${r},${c}" lsmatrixrowindex="${r}" lsmatrixcolindex="${c}" lsdata="{${extra}7:${sid(`${G}/[1]/rowcol/row[${r}]/cell[${c - 1}]`, "GuiGridViewCell")}}">${text}</td>`;
const cellInput = (r: number, c: number, value: string) =>
  td(r, c, `<span class="lsField lsField--table"><input id="grid#9#${r},${c}#if" maxlength="5" value="${value}" onkeydown="window.gridKeys=(window.gridKeys||'')+(event.ctrlKey?'^':'')+event.key+' '" lsdata="{0:'FREETEXT',20:${sid(`${G}/[1]/rowcol/row[${r}]/cell[${c - 1}]/`, "GuiTextField")}}"></span>`, "2:'EDIT',");
const GRID = `
<input id="NV" title="Net value" readonly value="1.250,00" lsdata="{0:'x',20:${sid("wnd[0]/usr/txtZ-NETWR", "GuiTextField")}}">
<table id="grid#9" ct="STCS" style="width:700px" lsdata="{10:'MULTI',29:{ColumnIDs:['CARRID','PLANETYPE','SEATSOCC'],ModalNo:0,SID:'${G}',Type:'GuiGridView'}}">
  <thead><tr><th colspan="3" class="urST3Tit"><span ct="CP" lsdata="{1:'Flights',6:false}">Flights</span></th></tr>
  <tr>${th(1, "CARRID", "ID", "urST3HUnsel", "headaoo")}${th(2, "PLANETYPE", "Plane Type", "urST3HSel")}${th(3, "SEATSOCC", "Occupied", "urST3HUnsel", "headotf")}</tr></thead>
  <tbody>
  <tr>${td(1, 1, "AA")}${cellInput(1, 2, "747")}${cellInput(1, 3, "373")}</tr>
  <tr>${td(2, 1, "AZ")}${cellInput(2, 2, "A380")}${td(2, 3, "12", "3:'COL_TOTAL',").replace("<td ", '<td class="urSTC urColorTotalIntensifiedOff" ')}</tr>
  <tr>${td(3, 1, "", "3:'COL_TOTAL_INTENSIFIED',")}${td(3, 2, "", "3:'COL_TOTAL_INTENSIFIED',")}${td(3, 3, "385", "3:'COL_TOTAL_INTENSIFIED',")}</tr>
  </tbody></table>`;

// The value help of a field with several search helps: one is shown, the others are behind the menu at the right of the title.
const HELPS = `
<div ct="PW" id="P1" lsdata="{0:'x',5:${sid("wnd[1]", "GuiModalWindow", 1)}}"><span id="P1-ttltxt">Material Number (1)</span>
<table ct="PST" id="PST1" lsdata="{8:'SH_Page10'}"><tr><td><span id="PST1-tgl" class="lsPnstTglIcon lsPnstTglIconExp" title="Collapse">v</span>
  <div id="PST1-itms"><div id="SH_Page10" ct="P" lsdata="{8:'M\\x3a\\x20Material\\x20by\\x20description',25:${sid("wnd[1]/shell/critcol", "GuiSearchHelpPage", 1)}}">M: Material by description</div>
  <div id="SH_Page11" ct="P" lsdata="{8:'A\\x3a\\x20Material\\x20by\\x20old\\x20material\\x20number'}">A: Material by old material number</div>
  <div id="SH_Page12" ct="P" lsdata="{8:'T\\x3a\\x20Material\\x20by\\x20Material\\x20Type'}">T: Material by Material Type</div></div>
  <a id="PST1-menuOpener" style="display:inline-block;width:16px;height:16px" onclick="document.getElementById('SHM').style.top='200px'">=</a></td></tr></table>
<div lsdata="{0:'Find',28:${sid("wnd[1]/shell/btnSEARCH", "GuiButton", 1)}}">Find</div></div>
<table id="SHM" style="position:absolute;top:-9999px;left:300px;background:#fff">
  <tr id="SH_Page10-menuItem" ct="POMNI" onclick="window.chosen='10'"><td>M: Material by description</td></tr>
  <tr id="SH_Page11-menuItem" ct="POMNI" onclick="window.chosen='11';document.getElementById('SHM').style.top='-9999px'"><td>A: Material by old material number</td></tr>
  <tr id="SH_Page12-menuItem" ct="POMNI" onclick="window.chosen='12';document.getElementById('SHM').style.top='-9999px'"><td>T: Material by Material Type</td></tr></table>`;

// The IMG: an activity node has two icons that are links (documentation, activity), before its text.
const T = "wnd[0]/usr/cntlTREE/shellcont/shell";
const item = (r: number, name: string, title: string) =>
  `<a id="tree#1#${r}#1#${name}#i" ct="LN" title="${title}" style="display:inline-block;width:16px;height:16px" onclick="window.item=(window.item||'')+'${r}/${name} '" ondblclick="window.item+='DBL '"><img alt=""><span></span></a>`;
const node = (r: number, key: string, lv: number, state: string, text: string, items = "") =>
  `<tr iidx="${r - 1}" dddata="${key}#2"><td id="tree#1#${r}#1" subct="HIC" lsdata="{4:${lv},5:'${state}'}" lsmatrixrowindex="${r}" lsmatrixcolindex="0" lv="${lv}"><table><tbody><tr><td>${items}</td><td><span ct="TV" id="tree#1#${r}#1#TEXT#i">${text}</span></td></tr></tbody></table></td></tr>`;
const TREE = `<table id="tree#1" ct="STCS" style="width:500px" lsdata="{29:{ModalNo:0,SID:'${T}',Type:'GuiTree'}}"><tbody>
  ${node(0, "04  2      3", 3, "EXPANDED", "Financial Accounting", item(0, "1", "Documentation") + item(0, "2", ""))}
  ${node(1, "05  3      1", 4, "INDENT", "Define company", item(1, "1", "IMG activity documentation") + item(1, "2", "IMG - Activity"))}
  ${node(2, "05  3      2", 4, "INDENT", "Define credit control area", item(2, "1", "IMG activity documentation") + item(2, "2", "IMG - Activity"))}
  </tbody></table>`;

// The error log of an editable grid: a popup with no button, only the x in its title; and an icon-only tab behind it.
const SHELL = `
<div id="B1" lsdata="{0:'Refresh',28:${sid("wnd[0]/usr/btnREFRESH", "GuiButton")}}" onclick="window.refreshed=1">Refresh</div>
<span title="Partners" style="display:inline-block;width:20px;height:20px" lsdata="{2:'\\x20',9:${sid("wnd[0]/usr/tabsTS/tabpOK_PEOPLE", "GuiTab")}}"><img alt=""></span>
<div ct="PW" id="DS1" style="position:absolute;top:0;left:0;width:400px;height:200px;background:#fff" lsdata="{13:{ModalNo:1,SID:'wnd[0]/dialogshell',Type:'GuiDialogShell'},15:true}">
  <div id="DS1-ttltxt" class="urPWTitleText">Error Log</div><a id="DS1-close" title="Close" style="display:inline-block;width:20px;height:20px" onclick="document.getElementById('DS1').style.display='none'">x</a>
  <span lsdata="{3:'The\\x20number\\x20of\\x20seats\\x20exceeds\\x20the\\x20capacity',19:${sid("wnd[0]/shellcont/lblMSG", "GuiLabel", 1)}}">The number of seats exceeds the capacity</span></div>`;

// Agent bench (2026-11): controls SAP greys out, a checkbox half under its neighbour, a dropdown whose list shows keys only.
const GREY = `
<div ct="B" id="GB1" class="lsButton lsButton--disabled" aria-disabled="true" style="display:inline-block;width:30px;height:20px" onclick="window.greyClicked=1" lsdata="{4:'Role\\x20Detail',5:false,27:${sid("wnd[0]/usr/btnZROLE", "GuiButton")}}"></div>
<div ct="B" id="GB2" class="lsButton" style="display:inline-block;width:30px;height:20px" onclick="window.goClicked=1" lsdata="{0:'Go',27:${sid("wnd[0]/usr/btnZGO", "GuiButton")}}">Go</div>
<div style="position:relative;width:300px;height:30px">
  <div ct="ALC" id="LC1" class="lsAbapList__checkbox" style="position:absolute;top:5px;left:16px;width:16px;height:19px" onclick="this.firstChild.className=this.firstChild.className==='urCImgOn'?'urCImgOff':'urCImgOn'" lsdata="{3:${sid("wnd[0]/usr/chk[2,9]", "ABAPLISTCHECKBOX")}}"><img class="urCImgOff" style="width:6px;height:6px"></div>
  <div ct="ALI" id="LI1" style="position:absolute;top:5px;left:24px;width:8px;height:19px;background:#ccc" onclick="window.neighbour=1" lsdata="{1:${sid("wnd[0]/usr/lbl[3,9]", "ABAPLISTIMAGE")}}"></div>
</div>
<input id="CB1" value="" onclick="document.getElementById('CB1_LB').style.display='block'" lsdata="{2:'CB1_LB',3:'',4:'',20:${sid("wnd[0]/usr/cmbZ-FKART", "GuiComboBox")}}">
<div id="CB1_LB" style="display:none"><div ct="LIB_I" data-itemkey="F1" onclick="document.getElementById('CB1').value='F1 Invoice (F1)';this.parentElement.style.display='none'">F1</div><div ct="LIB_I" data-itemkey="F2" onclick="document.getElementById('CB1').value='F2 Invoice';this.parentElement.style.display='none'">F2</div></div>
<div id="cua2sapmenu_btn" onclick="window.menuOpened=1">Menu</div>
<div class="lsMnu--root"><xmp><table><tr lsdata="{1:'Partner',18:${sid("wnd[0]/mbar/menu[0]", "GuiMenu")}}"></tr></table></xmp>
<xmp><table><tr lsdata="{1:'Open',15:'SHIFT_F5',18:${sid("wnd[0]/mbar/menu[0]/menu[0]", "GuiMenu")}}" id="wnd[0]/mbar/menu[0]/menu[0]" class="urMnuRowOff"></tr><tr lsdata="{1:'More\\x20Functions...',5:false,18:${sid("wnd[0]/mbar/menu[0]/menu[7]", "GuiMenu")}}" id="wnd[0]/mbar/menu[0]/menu[7]" aria-disabled="true" class="urMnuRowDsbl lsMnuItemHeight"></tr></table></xmp></div>`;

const page0 = (body: string) => `<!doctype html><html lang="en"><head><title>Synthetic</title></head><body>${HEAD}${body}</body></html>`;

describe.skipIf(!exe)("Web GUI reader: edge cases of round 3, in a browser", () => {
  let browser: Browser;
  let page: Page;
  const show = async (body: string) => {
    await page.setContent(page0(body));
    return page.mainFrame();
  };
  const full = async () => (await webguiLookInFrame(page.mainFrame(), false)) ?? "";
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: exe!, headless: true, args: ["--no-sandbox"] });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
  });

  test("ECCSCR-03: a text editor takes the lines of a value, and no Enter key is pressed", async () => {
    const f = await show(FIELDS);
    const text = 'Line one äöü\nLine "two" & <tag>\n\nLine four';
    expect(await webguiActInFrame(f, { do: "set", id: "cntlTEXT/shellcont/shell", value: text })).toBe("set wnd[0]/usr/cntlTEXT/shellcont/shell");
    expect(await page.locator("#TE1").inputValue()).toBe(text);
    expect(await page.evaluate(() => (window as unknown as { entered?: number }).entered ?? 0)).toBe(0);
    // The view shows the lines, "\n" between them.
    expect(await full()).toContain('wnd[0]/usr/cntlTEXT/shellcont/shell  text-editor  "Line one äöü\\nLine "two" & <tag>\\n\\nLine four"');
  });

  test("ECCSCR-03: a field that has one line gets a space for each line break, and the answer says so", async () => {
    const f = await show(FIELDS);
    const note = await webguiActInFrame(f, { do: "set", id: "txtZHDR-NAME", value: "one\ntwo" });
    expect(note).toBe("set wnd[0]/usr/txtZHDR-NAME (the value had line breaks and this field has one line: each was typed as a space)");
    expect(await page.locator("#F2").inputValue()).toBe("one two");
    expect(await page.evaluate(() => (window as unknown as { entered?: number }).entered ?? 0)).toBe(0);
  });

  test("ECCSCR-11: a value longer than the field: the answer says what the field holds", async () => {
    const f = await show(FIELDS);
    expect(await webguiActInFrame(f, { do: "set", id: "ctxtZHDR-TYPE", value: "ORDER" })).toBe(
      'set wnd[0]/usr/ctxtZHDR-TYPE (the field takes 4 characters: it holds "ORDE", not all 5 typed)',
    );
    expect(await webguiActInFrame(f, { do: "set", id: "ctxtZHDR-TYPE", value: "OR" })).toBe("set wnd[0]/usr/ctxtZHDR-TYPE");
  });

  test("ECCSCR-06: the operator of a selection criterion, an icon before the field, is a line of the view", async () => {
    await show(SELOPT);
    const view = await full();
    expect(view).toContain('wnd[0]/usr/txt%_MATNR_%_APP_%-OPTI_PUSH  label  icon "Select: Not equal to"');
    expect(compact(view)).toContain('txt%_MATNR_%_APP_%-OPTI_PUSH  label  icon "Select: Not equal to"\nctxtMATNR-LOW  field  Material = "M-17"  (edit)');
  });

  test("ECCSCR-07: the text of an HTML viewer is read, bounded in the screen's view and whole by its id", async () => {
    await show(HELP);
    const V = "wnd[0]/usr/cntlHELP/shellcont/shell";
    const lines = (await full()).split("\n");
    const at = lines.indexOf(`${V}  html-viewer`);
    expect(lines.slice(at + 1, at + 4)).toEqual(["  Sales Document Type", "  A classification that distinguishes between different types of sales document.", "  Use"]);
    // The long paragraph is cut, and the line after it says how to get the rest; the controls follow.
    expect(lines[at + 4]?.endsWith("...")).toBe(true);
    expect(lines[at + 5]).toMatch(/^ {2}\.\.\. \d+ more characters of text: sap_look with this viewer's id shows it$/);
    expect(lines.slice(at + 6, at + 9)).toEqual([`${V}/html[1]  link  sales document`, `${V}/html[2]  link  Glossary`, `${V}/html[3]  button  Close`]);
    expect(lines.slice(at + 1, at + 6).join("\n").length).toBeLessThan(2300);
    // By its id: the whole text, the table's rows with their cells, no line for a button or a link that stands alone.
    const whole = await view(new WebGuiSession(page.mainFrame()), { compact: true, id: V });
    expect(whole).toContain("  Sales document type | Parameter ID\n  Order | AAT");
    expect(whole).not.toContain("more characters");
    expect(whole).not.toContain("\n  Glossary");
    expect(whole).toContain("html[1]  link  sales document");
  });

  test("ECCSCR-05, ECCSCR-13: a grid says its title, selected columns, sorts, filters, totals, and which cells take input", async () => {
    await show(GRID);
    const lines = (await full()).split("\n");
    expect(lines).toContain(
      `${G}  grid  3 rows "Flights"; selected columns: PLANETYPE; CARRID sorted ascending, SEATSOCC totalled and filtered; cells that take input ("set" with "row" and "col"): PLANETYPE, SEATSOCC (rows 0); columns: CARRID=ID | PLANETYPE=Plane Type | SEATSOCC=Occupied`,
    );
    expect(lines).toContain("  row 0: AA | 747 | 373");
    expect(lines).toContain("  row 2 (total):  |  | 385");
    // R2 (SE16N): a column drawn in the totals colour does not make its rows totals rows.
    expect(lines).toContain("  row 1: AZ | A380 | 12");
  });

  test("ECCSCR-05: set with row and col types into a cell of a grid, without the keys that mean something else there", async () => {
    const f = await show(GRID);
    expect(await webguiActInFrame(f, { do: "set", id: G, row: 0, col: "SEATSOCC", value: "380" })).toBe(`set row 0 column SEATSOCC of ${G}`);
    expect(await page.locator("[id='grid#9#1,3#if']").inputValue()).toBe("380");
    // Ctrl+A selects the whole grid and Delete is the grid's: neither is pressed.
    const keys = await page.evaluate(() => (window as unknown as { gridKeys?: string }).gridKeys ?? "");
    expect(keys).not.toContain("^a");
    expect(keys).not.toContain("Delete");
    // A value longer than the cell, and a number in the other notation than the screen's.
    expect(await webguiActInFrame(f, { do: "set", id: G, row: 1, col: "PLANETYPE", value: "A380-800" })).toContain('the field takes 5 characters: it holds "A380-"');
    expect(await webguiActInFrame(f, { do: "set", id: G, row: 0, col: "SEATSOCC", value: "1.000" })).toContain('numbers on this screen have a decimal comma, e.g. "1.250,00": if this field is a number, "1.000" is read as 1000');
    // A cell that shows a value only, and the grid without a cell.
    expect(await webguiActInFrame(f, { do: "set", id: G, row: 1, col: "SEATSOCC", value: "1" }).catch((e: Error) => e.message)).toContain("does not take input");
    expect(await webguiActInFrame(f, { do: "set", id: G, value: "1" }).catch((e: Error) => e.message)).toContain('add "row" and "col"');
  });

  test("ECCSCR-04: the other search helps of a value help are counted, listed and chosen with combo", async () => {
    const f = await show(HELPS);
    expect(await full()).toContain('wnd[1]/shell/critcol  tab  M: Material by description (selected)  (1 of 3 search helps: "combo" on this id lists them, with "key" chooses one)');
    expect(await webguiActInFrame(f, { do: "combo", id: "critcol" })).toBe("wnd[1]/shell/critcol has 3 search helps: M:Material by description, A:Material by old material number, T:Material by Material Type");
    expect(await webguiActInFrame(f, { do: "combo", id: "critcol", key: "T" })).toContain('chose search help "T: Material by Material Type"');
    expect(await page.evaluate(() => (window as unknown as { chosen?: string }).chosen)).toBe("12");
    expect(await webguiActInFrame(f, { do: "combo", id: "critcol", key: "old material" })).toContain('chose search help "A: Material by old material number"');
    expect(await webguiActInFrame(f, { do: "combo", id: "critcol", key: "m" })).toContain("already shows");
    expect(await webguiActInFrame(f, { do: "combo", id: "critcol", key: "ZZ" }).catch((e: Error) => e.message)).toContain('no search help "ZZ"');
  });

  test("ECCSCR-04: a menu of search helps that closes under the click is opened again, or refused quickly", async () => {
    const f = await show(HELPS);
    // The menu closes again 180 ms after it opened, the first time only (a late first click and the second one that toggles it).
    await page.evaluate(() => {
      const m = document.getElementById("SHM") as HTMLElement;
      const b = document.getElementById("PST1-menuOpener") as HTMLElement;
      let n = 0;
      b.onclick = () => {
        m.style.top = "200px";
        if (n++ === 0) setTimeout(() => (m.style.top = "-9999px"), 180);
      };
    });
    const t0 = Date.now();
    expect(await webguiActInFrame(f, { do: "combo", id: "critcol", key: "T" })).toContain('chose search help "T: Material by Material Type"');
    expect(Date.now() - t0).toBeLessThan(6000);
    // A menu that never stays open: a refusal in plain words, not a locator timeout.
    await page.evaluate(() => {
      const m = document.getElementById("SHM") as HTMLElement;
      (document.getElementById("PST1-menuOpener") as HTMLElement).onclick = () => {
        m.style.top = "200px";
        setTimeout(() => (m.style.top = "-9999px"), 180);
      };
    });
    const t1 = Date.now();
    const e = await webguiActInFrame(f, { do: "combo", id: "critcol", key: "A" }).catch((x: Error) => x.message);
    expect(e).toContain("the menu of search helps of wnd[1]/shell/critcol did not open, so nothing was chosen");
    expect(e).not.toContain("Timeout");
    expect(Date.now() - t1).toBeLessThan(9000);
  }, 30_000);

  test("ECCSCR-09: the icons of a tree node that are links are its items, and tree with col clicks one", async () => {
    const f = await show(TREE);
    const lines = (await full()).split("\n");
    expect(lines).toContain(`${T}  tree  3 nodes shown; node items 2=IMG - Activity ("tree" with "node" and "col":"<item>" clicks one)`);
    expect(lines).toContain("          Define company [items 1=IMG activity documentation, 2]  {node 05 3 1}");
    expect(lines).toContain("        [-] Financial Accounting [items 1=Documentation]  {node 04 2 3}");
    expect(await webguiActInFrame(f, { do: "tree", id: T, node: "05 3 2", col: "1" })).toContain("tree clicked item 1 of node 05 3 2");
    // One click on that item of that node: no double-click (it would open the node).
    expect(await page.evaluate(() => (window as unknown as { item?: string }).item)).toBe("2/1 ");
  });

  test("a greyed-out button or menu entry is said in the view and refused at once, not after a click has timed out", async () => {
    const f = await show(GREY);
    const v = await full();
    expect(v).toContain("wnd[0]/usr/btnZROLE  button  Role Detail  (greyed out: SAP does not offer it now)");
    expect(v).toContain("wnd[0]/usr/btnZGO  button  Go");
    await expect(webguiActInFrame(f, { do: "press", id: "btnZROLE" })).rejects.toThrow("wnd[0]/usr/btnZROLE is greyed out: SAP does not offer it on this screen now");
    await expect(webguiActInFrame(f, { do: "select", id: "menu[0]/menu[7]" })).rejects.toThrow('menu entry wnd[0]/mbar/menu[0]/menu[7] "More Functions..." is greyed out');
    // Nothing was clicked: neither the button nor the Menu button that opens the menu.
    expect(await page.evaluate(() => (window as unknown as { greyClicked?: number; menuOpened?: number }).greyClicked ?? (window as unknown as { menuOpened?: number }).menuOpened)).toBeUndefined();
    const menus = (await menuLines(new WebGuiSession(f))).split("\n");
    expect(menus).toContain("    Open (SHIFT+F5)  {menu[0]/menu[0]}");
    expect(menus).toContain("    More Functions...  {menu[0]/menu[7]}  (greyed)");
    expect(menus[0]).toContain("(greyed): SAP does not offer it on this screen");
    // One menu alone: that menu and every entry below it.
    const one = (await menuLines(new WebGuiSession(f), "menu[0]")).split("\n");
    expect(one[0]).toStartWith("menu[0]  menu  ");
    expect(one).toContain("  Open (SHIFT+F5)  {menu[0]/menu[0]}");
    expect(await webguiActInFrame(f, { do: "press", id: "btnZGO" })).toContain("pressed wnd[0]/usr/btnZGO");
  }, 30_000);

  test("a control half under its neighbour is clicked on the part that shows (a checkbox of a classic list)", async () => {
    const f = await show(GREY);
    expect(await webguiActInFrame(f, { do: "check", id: "wnd[0]/usr/chk[2,9]" })).toContain("wnd[0]/usr/chk[2,9] checked");
    expect(await page.evaluate(() => (window as unknown as { neighbour?: number }).neighbour)).toBeUndefined();
    expect(await page.locator("#LC1 img").getAttribute("class")).toBe("urCImgOn");
    // What Playwright saw over a control that is covered whole is named.
    expect(coveredBy('  - <div id="urPopupWindowBlockLayer" class="x"></div> intercepts pointer events')).toStartWith("A popup window covers this control");
    expect(coveredBy('  - <tr ct="POMNI" id="wnd[0]/mbar/menu[0]">…</tr> intercepts pointer events')).toStartWith("An open menu covers this control");
    expect(coveredBy(`  - <div ct="ALI" data-ls="{1:{SID:'wnd[1]/usr/lbl[3,9]',Type:'ABAPLISTIMAGE'}}"></div> intercepts pointer events`)).toContain("Another control of the screen is drawn over it (wnd[1]/usr/lbl[3,9])");
  }, 30_000);

  test("a dropdown whose list shows the key and whose field shows key and text has taken the entry", async () => {
    const f = await show(GREY);
    expect(await webguiActInFrame(f, { do: "combo", id: "cmbZ-FKART", key: "F2" })).toContain("wnd[0]/usr/cmbZ-FKART = F2 Invoice");
    expect(await page.locator("#CB1").inputValue()).toBe("F2 Invoice");
    expect(await webguiActInFrame(f, { do: "combo", id: "cmbZ-FKART", key: "F2" })).toContain("wnd[0]/usr/cmbZ-FKART = F2 Invoice (it was already chosen)");
  }, 30_000);

  test("a popup without a button closes with the x in its title; an icon-only tab is named by its tooltip (ECCSCR-16)", async () => {
    const f = await show(SHELL);
    const view = await full();
    expect(view).toContain("wnd[1]/close  button  Close  (the x in the title of this window: it has no other button)");
    // An icon-only tab is named by its tooltip.
    expect(view).toContain("wnd[0]/usr/tabsTS/tabpOK_PEOPLE  tab  Partners");
    // Cancel (key 12) on a popup that has no Cancel button is that x too.
    expect(await webguiActInFrame(f, { do: "key", key: 12 })).toContain("closed the popup with the x in its title, which cancels it");
    await page.evaluate(() => (document.getElementById("DS1") as HTMLElement).style.removeProperty("display"));
    expect(await webguiActInFrame(f, { do: "press", id: "wnd[1]/close" })).toContain("pressed wnd[1]/close (the x in the window's title)");
    expect(await full()).not.toContain("WINDOW wnd[1]");
  });
});

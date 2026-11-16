/**
 * The Web GUI reader on SAP GUI for HTML of S/4HANA 2025, on pages built
 * from small snippets shaped like its markup (read on a 2025 system on
 * 2026-11-16; values made up, no SAP data). What differs from ECC:
 *
 * - `lsdata` is strict JSON, and only a window carries `ModalNo`: a control's
 *   window is the one its id names;
 * - a popup window is ct="PW_standards" (ECC: ct="PW"), its title in
 *   `<id>-header-title-txt`;
 * - an editable table cell is a `<span role="textbox">` until it is clicked;
 *   the input that replaces it carries its ids as JSON inside a string;
 * - the value help is a dialog of its own (wnd[N]/shell): token fields for
 *   the filters, a result list (GuiValueHelpResult), OK and Cancel typed as
 *   the dialog itself;
 * - the toolbar's ">>" button is a button inside `.lsToolbar--overflowButton`.
 *
 * Needs a Chrome: SAP_TEST_CHROME=/path/to/chrome.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { webguiActInFrame, webguiLookInFrame } from "../src/webgui/index.js";

const exe = process.env.SAP_TEST_CHROME;
/** An lsdata attribute value as S/4HANA 2025 writes it: JSON, quotes escaped for HTML. */
const ls = (o: unknown) => JSON.stringify(o).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const HEAD = `<!doctype html><html lang="en"><head><title>Synthetic</title><style>.lsToolbar--item-hidden{display:none}</style></head><body>
<div id="cuaheader" lsdata="${ls({ "1": "Create Standard Order" })}">Create Standard Order</div>
<input id="ToolbarOkCode" lsdata="${ls({ "0": "FREETEXT", "20": { SID: "wnd[0]/tbar[0]/okcd", Type: "GuiOKCodeField" } })}">`;
const button = (dom: string, sid: string, text: string, type = "GuiButton") =>
  `<div id="${dom}" ct="B" role="button" tabindex="0" lsdata="${ls({ "0": text, "27": { SID: sid, Type: type, SubType: "toolbar" } })}" onclick="window.pressed=(window.pressed||[]).concat('${text}')">${text}</div>`;

const POPUP = `${HEAD}
<input id="F1" value="X1" lsdata="${ls({ "21": { SID: "wnd[0]/usr/txtVBKD-BSTKD", Type: "GuiTextField" } })}">
<div id="webguiPopups"><div id="SAPLSPO1100_1" ct="PW_standards" role="dialog" class="lsPWNew" style="width:500px"
  lsdata="${ls({ "0": false, "8": "webguiKeys", "13": { SID: "wnd[1]", Type: "GuiModalWindow", ModalNo: 1 }, "16": true })}">
  <header id="SAPLSPO1100_1-header" class="lsPWNewHeader"><div id="SAPLSPO1100_1-header-title" role="heading"><span id="SAPLSPO1100_1-header-title-txt">Exit Order Processing</span></div></header>
  <section class="lsPWNewContentSection">
    <span ct="DTF" lsdata="${ls({ "1": "Do you wish to save your data first?", "15": { SID: "wnd[1]/usr/txtSPOP-TEXTLINE1", Type: "GuiLabel" } })}">Do you wish to save your data first?</span>
    ${button("B1", "wnd[1]/usr/btnSPOP-OPTION1", "Yes")}${button("B2", "wnd[1]/usr/btnSPOP-OPTION2", "No")}${button("B3", "wnd[1]/usr/btnSPOP-OPTION_CAN", "Cancel")}
  </section>
</div></div>
<script>document.getElementById('B1').focus(); document.addEventListener('keydown', function (e) { if (e.key === 'Enter') window.pressed = (window.pressed || []).concat('ENTER'); });</script>
</body></html>`;

const T = "wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG";
const cellSpan = (dom: string, id: string, type: string, text: string, ro: boolean) =>
  `<span class="lsField lsField--table${ro ? " lsField--readonly" : ""}"><span role="textbox" tabindex="0" id="${dom}" ct="CBS" style="display:inline-block;min-width:80px;height:20px"${ro ? ' aria-readonly="true" readonly' : ' onclick="openCell(this)"'}
    lsdata="${ls({ "1": "FREETEXT", "21": { SID: `${T}/${id}`, Type: type, value: text } })}">${text}</span></span>`;
const td = (r: number, c: number, id: string, inner: string) =>
  `<td id="tc[${r},${c}]" subct="STC" lsmatrixrowindex="${r}" lsmatrixcolindex="${c}" lsdata="${ls({ "7": { SID: `${T}/${id}`, Type: "SAPTABLECSCELL" } })}">${inner}</td>`;
const th = (c: number, name: string, title: string) =>
  `<th id="tc[0,${c}]" subct="HC" lsmatrixrowindex="0" lsmatrixcolindex="${c}" lsdata="${ls({ "7": title, "17": { SID: `${T}/col${name}`, Type: "GuiTableColumn" } })}">${title}</th>`;
const TABLE = `${HEAD}
<table id="tc" ct="STCS" style="width:600px" lsdata="${ls({ "10": "MULTI", "34": { SID: T, Type: "GuiTableControl", ColumnIds: ["VBAP-POSNR", "RV45A-MABNR", "RV45A-KWMENG"] } })}">
  <tr>${th(1, "VBAP-POSNR", "Item")}${th(2, "RV45A-MABNR", "Material")}${th(3, "RV45A-KWMENG", "Order Quantity")}</tr>
  <tr>${td(1, 1, "txtVBAP-POSNR[0,0]", cellSpan("c11", "txtVBAP-POSNR[0,0]", "GuiTextField", "10", true))}${td(1, 2, "ctxtRV45A-MABNR[1,0]", cellSpan("c12", "ctxtRV45A-MABNR[1,0]", "GuiCTextField", "", false))}${td(1, 3, "txtRV45A-KWMENG[2,0]", cellSpan("c13", "txtRV45A-KWMENG[2,0]", "GuiTextField", "", false))}</tr>
</table>
<script>
  // As Web GUI does: a click on the text box puts an input in its place, whose lsdata holds the ids as JSON in a string.
  function openCell(span) {
    var own = JSON.parse(span.getAttribute('lsdata'));
    var input = document.createElement('input');
    input.id = span.id; input.setAttribute('ct', 'CBS'); input.value = span.innerText;
    input.setAttribute('lsdata', JSON.stringify({ '1': 'FREETEXT', '21': JSON.stringify(own['21']) }));
    span.replaceWith(input); input.focus();
  }
</script>
</body></html>`;

const crit = (n: number, sid: string, label: string, value: string) => {
  const own = { SID: `wnd[2]/shell/critcol/${sid}`, Type: "GuiSearchHelpHeaderItem", LabelledBy: label };
  return `<div id="NSHHIC2_${n}" ct="SL" lsdata="${ls({ "1": own })}"><label ct="L" for="NSHHI2_${n}-input">${label}</label>
    <div id="NSHHI2_${n}" ct="TOKENIZER" lsdata="${ls({ "0": `NSHHI2_${n}`, "2": own })}"><input id="NSHHI2_${n}-input" ct="CBS" role="textbox" value="${value}" lsdata="${ls({ "1": "FREETEXT" })}"></div></div>`;
};
/** A filter that holds its value as a token: no input until the token is removed (a click on it, then Backspace). */
const tokenCrit = (n: number, sid: string, label: string, value: string) => {
  const own = { SID: `wnd[2]/shell/critcol/${sid}`, Type: "GuiSearchHelpHeaderItem", LabelledBy: label };
  return `<div id="NSHHIC2_${n}" ct="SL" lsdata="${ls({ "1": own })}"><label ct="L">${label}</label>
    <div id="NSHHI2_${n}" ct="TOKENIZER" class="c2Tokenizer c2Tokenizer--noInput" lsdata="${ls({ "0": `NSHHI2_${n}`, "2": own })}"><span ct="TOKEN" tabindex="0" class="c2Token"
      lsdata="${ls({ "0": { SID: `${own.SID}/cond[0]`, Type: "GuiSearchHelp" }, "13": value })}" onkeydown="if (event.key === 'Backspace') dropToken(this)"><div class="c2Token__text">${value}</div></span></div></div>`;
};
const G = "wnd[2]/shell/gridRESULT";
const VALUE_HELP = `${HEAD}
<input id="F1" value="" lsdata="${ls({ "21": { SID: "wnd[0]/usr/ctxtRV45S-KUNNR", Type: "GuiCTextField" } })}">
<div id="SearchHelp2" ct="PW_standards" role="dialog" class="lsPWNew" style="width:700px" lsdata="${ls({ "13": { SID: "wnd[2]/shell", Type: "GuiSearchHelp", ModalNo: 2 } })}">
  <header class="lsPWNewHeader"><div role="heading"><span id="SearchHelp2-header-title-txt">Restrict Value Range (1)</span></div></header>
  <table ct="TS_standards" lsdata="${ls({ "11": { SID: "wnd[2]/shell", Type: "GuiSearchHelp", ModalNo: "2" } })}"><tr><td>
    ${crit(0, "crit1800", "Sales Organization", "1710")}${crit(1, "crit1806", "Customer", "")}${tokenCrit(2, "crit1805", "Name", "*DOM*")}
    ${button("btnGO2", "wnd[2]/shell/btnSEARCH", "Go")}
    <table id="SHresultgrid2" ct="STCS" style="width:500px" lsdata="${ls({ "10": "SINGLE", "34": { SID: G, Type: "GuiValueHelpResult", firstrow: 1 } })}">
      <tr><th id="NAME_2" lsmatrixrowindex="0" lsmatrixcolindex="1" lsdata="${ls({ "7": "Name", "17": { SID: `${G}/colMCOD1`, Type: "GuiTableColumn" } })}">Name 1</th>
          <th id="KUNNR_2" lsmatrixrowindex="0" lsmatrixcolindex="2" lsdata="${ls({ "7": "Customer", "17": { SID: `${G}/colKUNNR`, Type: "GuiTableColumn" } })}">Customer</th></tr>
      <tr><td id="sh[1,0]#sc" subct="SC" lsmatrixrowindex="1" lsmatrixcolindex="0" class="urSTSC" onclick="pick(this)"><div class="urSTRowUnSelIcon">&nbsp;</div></td>
          <td id="sh[1,1]" lsmatrixrowindex="1" lsmatrixcolindex="1">ALPHA INC</td><td id="sh[1,2]" lsmatrixrowindex="1" lsmatrixcolindex="2">1000001</td></tr>
      <tr><td id="sh[2,0]#sc" subct="SC" lsmatrixrowindex="2" lsmatrixcolindex="0" class="urSTSC" onclick="pick(this)"><div class="urSTRowUnSelIcon">&nbsp;</div></td>
          <td id="sh[2,1]" lsmatrixrowindex="2" lsmatrixcolindex="1">BETA LTD</td><td id="sh[2,2]" lsmatrixrowindex="2" lsmatrixcolindex="2">1000002</td></tr>
    </table>
    ${button("NSH2_copy", `${G}/tbar/btnCOPY`, "OK", "GuiSearchHelp")}${button("NSH2_close", "wnd[2]/shell/tbar/btnCLOSE", "Cancel", "GuiSearchHelp")}
  </td></tr></table>
</div>
<script>
  function dropToken(token) {
    var field = token.parentElement; token.remove();
    var input = document.createElement('input'); input.id = field.id + '-input'; input.setAttribute('ct', 'CBS'); field.appendChild(input); input.focus();
  }
  function pick(td) { var d = td.firstElementChild; var on = /UnSel/.test(d.className); d.className = on ? 'urSTRowSelSecIcon' : 'urSTRowUnSelIcon'; }
</script>
</body></html>`;

const refusal = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "",
    (e: unknown) => (e as Error).message,
  );

describe.skipIf(!exe)("Web GUI reader: SAP GUI for HTML of S/4HANA 2025, in a browser", () => {
  let browser: Browser;
  let page: Page;
  const fullView = async () => ((await webguiLookInFrame(page.mainFrame(), false)) ?? "").split("\n");
  const compactView = async () => (await webguiLookInFrame(page.mainFrame(), true)) ?? "";
  const NOTHING_SENT = /\nNothing was sent to SAP[^\n]*$/;
  const act = async (a: Parameters<typeof webguiActInFrame>[1]) => (await webguiActInFrame(page.mainFrame(), a)).replace(NOTHING_SENT, "");
  const load = async (html: string) => {
    await page.setContent(html);
    await page.evaluate(() => {
      (window as unknown as { pressed?: string[] }).pressed = [];
    });
  };
  const pressed = () => page.evaluate(() => (window as unknown as { pressed?: string[] }).pressed ?? []);
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: exe!, headless: true, args: ["--no-sandbox"] });
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  });
  afterAll(async () => {
    await browser?.close();
  });

  test("a popup (ct PW_standards, controls without ModalNo) is a window with its title", async () => {
    await load(POPUP);
    const full = await fullView();
    expect(full).toContain('WINDOW wnd[1]  "Exit Order Processing"');
    const at = full.indexOf('WINDOW wnd[1]  "Exit Order Processing"');
    expect(full.slice(at + 1)).toEqual([
      "wnd[1]/usr/txtSPOP-TEXTLINE1  label  Do you wish to save your data first?",
      "wnd[1]/usr/btnSPOP-OPTION1  button  Yes",
      "wnd[1]/usr/btnSPOP-OPTION2  button  No",
      "wnd[1]/usr/btnSPOP-OPTION_CAN  button  Cancel",
    ]);
    // The main window's field stays in the main window.
    expect(full.indexOf('wnd[0]/usr/txtVBKD-BSTKD  field   = "X1"  (edit)')).toBeLessThan(at);
  });

  test("Enter on that question popup is refused, with the answers; the answer meant is pressed by its id", async () => {
    await load(POPUP);
    const said = await refusal(act({ do: "key", key: 0 }));
    expect(said).toContain('Enter on the popup "Exit Order Processing"');
    expect(said).toContain("nothing was pressed");
    expect(said).toContain('wnd[1]/usr/btnSPOP-OPTION1 "Yes", wnd[1]/usr/btnSPOP-OPTION2 "No", wnd[1]/usr/btnSPOP-OPTION_CAN "Cancel"');
    expect(await pressed()).toEqual([]);
    expect(await act({ do: "press", id: "btnSPOP-OPTION2" })).toBe("pressed wnd[1]/usr/btnSPOP-OPTION2");
    expect(await pressed()).toEqual(["No"]);
  });

  test("a table cell drawn as a text box is a field: read with its column, read-only or not", async () => {
    await load(TABLE);
    const full = await fullView();
    expect(full).toContain(`${T}/txtVBAP-POSNR[0,0]  field  Item = "10"  (read-only)`);
    expect(full).toContain(`${T}/ctxtRV45A-MABNR[1,0]  field  Material = ""  (edit)`);
    expect(full).toContain(`${T}/txtRV45A-KWMENG[2,0]  field  Order Quantity = ""  (edit)`);
    // Each cell once: not also as the cell around it.
    expect(full.filter((l) => l.includes("txtVBAP-POSNR[0,0]"))).toHaveLength(1);
    const compact = await compactView();
    expect(compact).toContain("0 Item=txtVBAP-POSNR (read-only), 1 Material=ctxtRV45A-MABNR, 2 Order Quantity=txtRV45A-KWMENG");
    expect(compact).toContain("row 0: Item=10");
  });

  test("set on such a cell clicks it open and types; the input's ids (JSON in a string) are read back", async () => {
    await load(TABLE);
    expect(await act({ do: "set", id: "ctxtRV45A-MABNR[1,0]", value: "TG11" })).toBe(`set ${T}/ctxtRV45A-MABNR[1,0]`);
    expect(await act({ do: "set", id: "txtRV45A-KWMENG[2,0]", value: "5" })).toBe(`set ${T}/txtRV45A-KWMENG[2,0]`);
    const full = await fullView();
    expect(full).toContain(`${T}/ctxtRV45A-MABNR[1,0]  field  Material = "TG11"  (edit)`);
    expect(full).toContain(`${T}/txtRV45A-KWMENG[2,0]  field  Order Quantity = "5"  (edit)`);
    expect(await refusal(act({ do: "set", id: "txtVBAP-POSNR[0,0]", value: "20" }))).toContain("is read-only");
  });

  test("the value help dialog: a window with its filters, result list, OK and Cancel", async () => {
    await load(VALUE_HELP);
    const full = await fullView();
    const at = full.indexOf('WINDOW wnd[2]  "Restrict Value Range (1)"');
    expect(at).toBeGreaterThan(0);
    expect(full.slice(at + 1)).toEqual([
      'wnd[2]/shell/critcol/crit1800  field  Sales Organization = "1710"  (edit)',
      'wnd[2]/shell/critcol/crit1806  field  Customer = ""  (edit)',
      'wnd[2]/shell/critcol/crit1805  field  Name = "*DOM*"  (edit)',
      "wnd[2]/shell/btnSEARCH  button  Go",
      "wnd[2]/shell/gridRESULT  grid  2 rows; rows can be selected; columns: MCOD1=Name 1 | KUNNR=Customer",
      "  row 0: ALPHA INC | 1000001",
      "  row 1: BETA LTD | 1000002",
      "wnd[2]/shell/gridRESULT/tbar/btnCOPY  button  OK",
      "wnd[2]/shell/tbar/btnCLOSE  button  Cancel",
    ]);
  });

  test("the value help dialog is used: a filter is typed into, a row selected, OK pressed", async () => {
    await load(VALUE_HELP);
    expect(await act({ do: "set", id: "crit1806", value: "1000002" })).toBe("set wnd[2]/shell/critcol/crit1806");
    expect(await page.locator("[id='NSHHI2_1-input']").inputValue()).toBe("1000002");
    expect(await act({ do: "press", id: "btnSEARCH" })).toBe("pressed wnd[2]/shell/btnSEARCH");
    expect(await act({ do: "grid", id: G, row: 1, how: "select" })).toBe(`selected row 1 of ${G}`);
    expect(await fullView()).toContain("  row 1 (selected): BETA LTD | 1000002");
    expect(await act({ do: "press", id: "btnCOPY" })).toBe(`pressed ${G}/tbar/btnCOPY`);
    expect(await pressed()).toEqual(["Go", "OK"]);
  });

  test("a filter that holds a token: set removes the token and types the new value", async () => {
    await load(VALUE_HELP);
    expect(await act({ do: "set", id: "crit1805", value: "*ALPHA*" })).toBe("set wnd[2]/shell/critcol/crit1805");
    expect(await fullView()).toContain('wnd[2]/shell/critcol/crit1805  field  Name = "*ALPHA*"  (edit)');
    expect(await page.locator("[ct='TOKEN']").count()).toBe(0);
  });
});

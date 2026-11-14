/**
 * The Web GUI reader on a synthetic page that uses Web GUI's markup (lsdata,
 * system information items, menu template). It needs a Chrome to run in:
 *
 *   SAP_TEST_CHROME=/path/to/chrome bun test test/webgui-reader.test.ts
 *
 * Without SAP_TEST_CHROME the browser tests are skipped.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { webguiActInFrame, webguiAssessInFrame, webguiLookInFrame } from "../src/webgui/index.js";
import { extractFacts, extractMenus, markControl, normalizeLsdata } from "../src/webgui/page.js";
import { vkey } from "../src/webgui/reader.js";

const sid = (id: string, type: string, modal = 0) => `{ModalNo:${modal},SID:'${id}',Type:'${type}'}`;

// A made-up screen. `lsdata` is written as Web GUI of ECC writes it, except one field in the JSON form of S/4HANA 2025.
const PAGE = `<!doctype html><html><head><title>Synthetic</title></head><body>
<div id="cuaheader" lsdata="{1:'Change\\x20Synthetic\\x20Order'}">Change Synthetic Order</div>
<input id="ToolbarOkCode" lsdata="{0:'FREETEXT',20:${sid("wnd[0]/tbar[0]/okcd", "GuiOKCodeField")}}">
<div title="Save (Ctrl+S)" lsdata="{0:'Save',19:'CTRL_S',28:${sid("wnd[0]/tbar[0]/btn[11]", "GuiButton")}}">Save</div>
<div title="Back (F3)" lsdata="{0:'Back',19:'F3',28:${sid("wnd[0]/tbar[0]/btn[3]", "GuiButton")}}">Back</div>
<label id="L1" lsdata="{1:'F1',3:'Order\\x20Type',19:${sid("wnd[0]/usr/lblZHDR-TYPE", "GuiLabel")}}">Order Type</label>
<input id="F1" value="AB" lsdata="{0:'x',20:${sid("wnd[0]/usr/ctxtZHDR-TYPE", "GuiCTextField")}}">
<label id="L2" lsdata="{1:'F2',3:'Net\\x20value',19:${sid("wnd[0]/usr/lblZHDR-NETWR", "GuiLabel")}}">Net value</label>
<input id="F2" value="1.250,00" readonly lsdata="{0:'x',20:${sid("wnd[0]/usr/txtZHDR-NETWR", "GuiTextField")}}">
<input id="F3" title="Reference" value="R1" lsdata='{"0":"x","20":{"ModalNo":0,"SID":"wnd[0]/usr/txtZHDR-REF","Type":"GuiTextField"}}'>
<span class="lsCheckBox lsCheckBox--checked" lsdata="{4:'Complete',9:${sid("wnd[0]/usr/chkZHDR-DONE", "GuiCheckBox")}}">Complete</span>
<span aria-selected="true" lsdata="{2:'Sales',9:${sid("wnd[0]/usr/tabsTS/tabpT\\\\01", "GuiTab")}}">Sales</span>
<span lsdata="{2:'Shipping',9:${sid("wnd[0]/usr/tabsTS/tabpT\\\\02", "GuiTab")}}">Shipping</span>
<div lsdata="{0:'Delete\\x20item',28:${sid("wnd[0]/usr/btnBT_DEL", "GuiButton")}}">Delete item</div>
<div id="msgarea"><span id="wnd[0]/sbar_msg" lsdata="{0:'Order\\x20type\\x20ZZ\\x20is\\x20not\\x20defined',1:'ERROR'}">Order type ZZ is not defined</span><span ct="TV">XYZ (100)</span></div>
<div class="lsMnu--root"><xmp><table lsdata="{6:${sid("wnd[0]/mbar", "GuiMenu")}}"><tr lsdata="{1:'Order',6:true,18:${sid("wnd[0]/mbar/menu[0]", "GuiMenu")}}"></tr><tr lsdata="{1:'Edit',18:${sid("wnd[0]/mbar/menu[1]", "GuiMenu")}}"></tr></table></xmp>
<xmp><table lsdata="{6:${sid("wnd[0]/mbar/menu[0]", "GuiMenu")}}"><tr lsdata="{1:'Save',15:'CTRL_S',18:${sid("wnd[0]/mbar/menu[0]/menu[0]", "GuiMenu")}}"></tr><tr lsdata="{1:'Display\\x20log',15:'CTRL_F8',18:${sid("wnd[0]/mbar/menu[0]/menu[1]", "GuiMenu")}}"></tr></table></xmp></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_SYSTEM" lsdata="{0:'abc',1:'System',13:'XYZ\\x20(100)'}"></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_CLIENT" lsdata="{0:'abc',1:'Client',13:'100'}"></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_USER" lsdata="{0:'abc',1:'User',13:'TESTER'}"></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_DYNPRO" lsdata="{0:'abc',1:'Screen',13:'ZPROG/0200'}"></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_TRANSACTION" lsdata="{0:'abc',1:'Transaction',13:'ZT02'}"></div>
<div ct="PW" id="P1" lsdata="{0:'x',5:${sid("wnd[1]", "GuiModalWindow", 1)}}"><span id="P1-ttltxt">Exit Order Processing</span>
<span lsdata="{1:'',3:'Do\\x20you\\x20wish\\x20to\\x20save\\x20your\\x20data\\x20first?',19:${sid("wnd[1]/usr/txtSPOP-TEXTLINE1", "GuiLabel", 1)}}">Do you wish to save your data first?</span>
<div lsdata="{0:'Yes',28:${sid("wnd[1]/usr/btnSPOP-OPTION1", "GuiButton", 1)}}">Yes</div>
<div lsdata="{0:'No',28:${sid("wnd[1]/usr/btnSPOP-OPTION2", "GuiButton", 1)}}">No</div></div>
</body></html>`;

const EXPECTED = [
  "TRANSACTION ZT02  PROGRAM ZPROG  SCREEN 0200  SYSTEM XYZ (100)",
  'WINDOW wnd[0]  "Change Synthetic Order"',
  "wnd[0]/tbar[0]/okcd  command-field",
  "wnd[0]/tbar[0]/btn[11]  button  Save (Ctrl+S)",
  "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
  'wnd[0]/usr/ctxtZHDR-TYPE  field  Order Type = "AB"  (edit)',
  'wnd[0]/usr/txtZHDR-NETWR  field  Net value = "1.250,00"  (read-only)',
  'wnd[0]/usr/txtZHDR-REF  field  Reference = "R1"  (edit)',
  "wnd[0]/usr/chkZHDR-DONE  checkbox  [x] Complete",
  "wnd[0]/usr/tabsTS/tabpT\\01  tab  Sales (selected)",
  "wnd[0]/usr/tabsTS/tabpT\\02  tab  Shipping",
  "wnd[0]/usr/btnBT_DEL  button  Delete item",
  "wnd[0]/sbar  status  E: Order type ZZ is not defined",
  "wnd[0]/mbar  menubar  Order {menu[0]}, Edit {menu[1]}",
  'WINDOW wnd[1]  "Exit Order Processing"',
  "wnd[1]/usr/txtSPOP-TEXTLINE1  label  Do you wish to save your data first?",
  "wnd[1]/usr/btnSPOP-OPTION1  button  Yes",
  "wnd[1]/usr/btnSPOP-OPTION2  button  No",
];

test("virtual keys map to the keys Web GUI listens to", () => {
  expect(vkey(0)).toBe("Enter");
  expect(vkey(3)).toBe("F3");
  expect(vkey(11)).toBe("Control+s");
  expect(vkey(12)).toBe("Escape");
  expect(vkey(15)).toBe("Shift+F3");
  expect(vkey(26)).toBe("Control+F2");
  expect(vkey(45)).toBe("Control+Shift+F9");
  expect(vkey("F8")).toBe("F8");
  expect(() => vkey(99)).toThrow("unknown virtual key");
});

const exe = process.env.SAP_TEST_CHROME;

describe.skipIf(!exe)("Web GUI reader in a browser", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: exe!, headless: true, args: ["--no-sandbox"] });
    page = await browser.newPage();
    // Web GUI's own String.prototype.trim is slow on long text: the reader must not call it.
    await page.addInitScript(() => {
      String.prototype.trim = () => {
        throw new Error("the reader called trim()");
      };
    });
    await page.setContent(PAGE);
  });
  afterAll(async () => {
    await browser?.close();
  });

  test("the full view has one line per control, by window", async () => {
    expect((await webguiLookInFrame(page.mainFrame(), false))?.split("\n")).toEqual(EXPECTED);
  });

  test("the compact view shortens the ids", async () => {
    const lines = (await webguiLookInFrame(page.mainFrame(), true))?.split("\n") ?? [];
    expect(lines).toContain('ctxtZHDR-TYPE  field  Order Type = "AB"  (edit)');
    expect(lines).toContain("tabpT\\02  tab  Shipping");
    expect(lines).toContain("wnd[0]/tbar[0]/btn[11]  button  Save (Ctrl+S)");
    expect(lines).toHaveLength(EXPECTED.length);
  });

  test("session facts come from the system information items", async () => {
    expect(await page.evaluate(extractFacts)).toEqual({ webgui: true, system: "XYZ", client: "100", user: "TESTER", transaction: "ZT02", title: "Change Synthetic Order" });
  });

  test("menu entries come with their shortcuts", async () => {
    const menus = await page.evaluate(extractMenus);
    expect(menus).toContainEqual({ sid: "wnd[0]/mbar/menu[0]/menu[0]", text: "Save", key: "CTRL_S" });
    expect(menus).toContainEqual({ sid: "wnd[0]/mbar/menu[0]/menu[1]", text: "Display log", key: "CTRL_F8" });
  });

  test("an id resolves by full id, tail or SAP name; a SAP name means the field, not its label", async () => {
    await page.evaluate(normalizeLsdata);
    for (const id of ["wnd[0]/usr/ctxtZHDR-TYPE", "ctxtZHDR-TYPE", "ZHDR-TYPE"]) expect(await page.evaluate(markControl, id)).toMatchObject({ sid: "wnd[0]/usr/ctxtZHDR-TYPE", type: "GuiCTextField", readonly: false });
    expect(await page.evaluate(markControl, "ZHDR-REF")).toMatchObject({ sid: "wnd[0]/usr/txtZHDR-REF" }); // JSON lsdata
    expect(await page.evaluate(markControl, "chkZHDR-DONE")).toMatchObject({ checked: true });
    expect(await page.evaluate(markControl, "nothing")).toBe("no control named nothing");
  });

  test("actions are assessed from the screen", async () => {
    const f = page.mainFrame();
    expect((await webguiAssessInFrame(f, { do: "press", id: "btnSPOP-OPTION1" })).risk).toBe("commit");
    expect((await webguiAssessInFrame(f, { do: "press", id: "btnSPOP-OPTION2" })).risk).toBe("navigate");
    expect((await webguiAssessInFrame(f, { do: "select", id: "menu[0]/menu[0]" })).risk).toBe("commit");
    expect((await webguiAssessInFrame(f, { do: "press", id: "btnBT_DEL" })).risk).toBe("commit");
    expect((await webguiAssessInFrame(f, { do: "set", id: "ZHDR-TYPE", value: "CD" })).risk).toBe("navigate");
  });

  test("set types into the field; a read-only field refuses", async () => {
    const f = page.mainFrame();
    expect(await webguiActInFrame(f, { do: "set", id: "ZHDR-TYPE", value: "CD" })).toBe("set wnd[0]/usr/ctxtZHDR-TYPE");
    expect(await page.locator("#F1").inputValue()).toBe("CD");
    expect(webguiActInFrame(f, { do: "set", id: "ZHDR-NETWR", value: "1" })).rejects.toThrow("read-only");
    expect(webguiActInFrame(f, { do: "press", id: "nothing" })).rejects.toThrow("no control named nothing");
  });

  test("a page that is not Web GUI gives null", async () => {
    const other = await browser.newPage();
    await other.setContent("<html><body><input id='q'></body></html>");
    expect(await webguiLookInFrame(other.mainFrame(), true)).toBeNull();
    await other.close();
  });
});

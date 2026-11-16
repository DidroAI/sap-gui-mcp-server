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
import { ActionError } from "../src/core/types.js";
import { webguiActInFrame, webguiAssessInFrame, webguiLookInFrame } from "../src/webgui/index.js";
import { extractFacts, extractMenus, focusedControl, markControl, normalizeLsdata } from "../src/webgui/page.js";
import { vkey } from "../src/webgui/reader.js";

const sid = (id: string, type: string, modal = 0) => `{ModalNo:${modal},SID:'${id}',Type:'${type}'}`;

// A made-up screen. `lsdata` is written as Web GUI of ECC writes it, except one field in the JSON form of S/4HANA 2025.
const PAGE = `<!doctype html><html lang="en"><head><title>Synthetic</title></head><body>
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
<div id="B1" tabindex="0" onclick="window.pressed=(window.pressed||0)+1" onkeydown="window.keys=(window.keys||'')+event.key" lsdata="{0:'Delete\\x20item',28:${sid("wnd[0]/usr/btnBT_DEL", "GuiButton")}}">Delete item</div>
<div id="B2" tabindex="0" lsdata="{0:'Display\\x20item',28:${sid("wnd[0]/usr/btnBT_SHOW", "GuiButton")}}">Display item</div>
<input id="F4" type="password" title="Secret" value="hunter2" lsdata="{0:'x',20:${sid("wnd[0]/usr/pwdZHDR-SECRET", "GuiPasswordField")}}">
<input id="F5" type="password" title="Token" value="hunter3" lsdata="{0:'x',20:${sid("wnd[0]/usr/txtZHDR-TOKEN", "GuiTextField")}}">
<iframe id="V1" style="width:300px;height:80px" lsdata="{0:'x',20:${sid("wnd[0]/usr/cntlHTML/shellcont/shell", "GuiHtmlViewer")}}" srcdoc="<input id='p' type='password' title='PIN' value='hunter4'><input id='t' title='Query' value='abc'><button id='go'>Approve all</button><a id='l' href='#x'>Show details</a>"></iframe>
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
  "wnd[0]/usr/btnBT_SHOW  button  Display item",
  'wnd[0]/usr/pwdZHDR-SECRET  field  Secret = "***"  (edit)',
  'wnd[0]/usr/txtZHDR-TOKEN  field  Token = "***"  (edit)',
  "wnd[0]/usr/cntlHTML/shellcont/shell  html-viewer",
  'wnd[0]/usr/cntlHTML/shellcont/shell/html[1]  field  PIN = "***"  (edit)',
  'wnd[0]/usr/cntlHTML/shellcont/shell/html[2]  field  Query = "abc"  (edit)',
  "wnd[0]/usr/cntlHTML/shellcont/shell/html[3]  button  Approve all",
  "wnd[0]/usr/cntlHTML/shellcont/shell/html[4]  link  Show details",
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

/** The message an action or an assessment is refused with ("" when it is not). Awaited here: `expect(...).rejects` is slow on promises that wait for the browser. */
const refusal = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "",
    (e: unknown) => (e instanceof ActionError ? e.message : `not an ActionError: ${String(e)}`),
  );

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
    // A popup is open: behind it the view keeps what the screen shows (the selected tab), not what cannot be used (the other tabs).
    expect(lines).toContain("tabpT\\01  tab  Sales (selected)");
    expect(lines).not.toContain("tabpT\\02  tab  Shipping");
    // Buttons of the screen behind cannot be pressed while the popup is open: the full view has them.
    expect(lines.some((l) => l.includes("Save"))).toBe(false);
    expect(lines).toContain("  (10 more lines behind the popup: buttons, menus, empty fields, list rows; sap_look full=true shows them)");
    expect(lines.length).toBeLessThan(EXPECTED.length);
  });

  test("session facts come from the system information items", async () => {
    expect(await page.evaluate(extractFacts)).toEqual({
      webgui: true,
      system: "XYZ",
      client: "100",
      user: "TESTER",
      transaction: "ZT02",
      title: "Change Synthetic Order",
      program: "ZPROG",
      language: "en",
      // A password field inside a Web GUI screen does not make it a logon page.
      logon: false,
    });
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
    expect(await refusal(webguiActInFrame(f, { do: "set", id: "ZHDR-NETWR", value: "1" }))).toContain("read-only");
    expect(await refusal(webguiActInFrame(f, { do: "press", id: "nothing" }))).toContain('No control "nothing" on this screen');
  });

  test("no view shows a password", async () => {
    for (const compact of [true, false]) {
      const view = (await webguiLookInFrame(page.mainFrame(), compact)) ?? "";
      for (const secret of ["hunter2", "hunter3", "hunter4"]) expect(view).not.toContain(secret);
      expect(view).toContain('Secret = "***"');
      expect(view).toContain('PIN = "***"');
    }
    await page.evaluate(normalizeLsdata);
    expect(await page.evaluate(markControl, "pwdZHDR-SECRET")).toMatchObject({ type: "GuiPasswordField", inputType: "password" });
    expect(await page.evaluate(markControl, "ZHDR-TOKEN")).toMatchObject({ type: "GuiTextField", inputType: "password" });
  });

  test("set never types a password: by the field's type, by the input's type, and in an HTML viewer", async () => {
    const f = page.mainFrame();
    for (const id of ["pwdZHDR-SECRET", "txtZHDR-TOKEN", "html[1]"]) expect(await refusal(webguiActInFrame(f, { do: "set", id, value: "new" }))).toContain("password field: this server never types a password");
    expect(await page.locator("#F4").inputValue()).toBe("hunter2");
    expect(await page.locator("#F5").inputValue()).toBe("hunter3");
    expect(await page.frameLocator("#V1").locator("#p").inputValue()).toBe("hunter4");
    // A plain field of the viewer is still typed into.
    await webguiActInFrame(f, { do: "set", id: "html[2]", value: "xyz" });
    expect(await page.frameLocator("#V1").locator("#t").inputValue()).toBe("xyz");
  });

  test("set, check and combo on a button are refused: the button is not focused, typed on or clicked", async () => {
    const f = page.mainFrame();
    await page.evaluate(() => {
      (window as unknown as { pressed: number; keys: string }).pressed = 0;
      (window as unknown as { pressed: number; keys: string }).keys = "";
      (document.activeElement as HTMLElement | null)?.blur();
    });
    expect(await refusal(webguiActInFrame(f, { do: "set", id: "btnBT_DEL", value: " " }))).toContain('not a field: "set" types into fields only');
    expect(await refusal(webguiActInFrame(f, { do: "check", id: "btnBT_DEL", value: true }))).toContain("not a checkbox");
    expect(await refusal(webguiActInFrame(f, { do: "combo", id: "btnBT_DEL", key: "A" }))).toContain("not a dropdown");
    expect(await refusal(webguiActInFrame(f, { do: "f4", id: "btnBT_DEL" }))).toContain("value help works on fields");
    expect(await refusal(webguiActInFrame(f, { do: "set", id: "tabpT\\02", value: "x" }))).toContain("not a field");
    expect(await refusal(webguiActInFrame(f, { do: "set", id: "html[3]", value: " " }))).toContain("not a field");
    const w = await page.evaluate(() => {
      const x = window as unknown as { pressed: number; keys: string };
      return { pressed: x.pressed, keys: x.keys };
    });
    expect(w).toEqual({ pressed: 0, keys: "" });
    expect(await page.evaluate(() => document.activeElement?.id)).not.toBe("B1");
  });

  test("Enter and Space are assessed against the control that has the focus", async () => {
    const f = page.mainFrame();
    await page.locator("#B1").focus(); // "Delete item"
    expect(await page.evaluate(focusedControl)).toMatchObject({ sid: "wnd[0]/usr/btnBT_DEL", type: "GuiButton" });
    // Space presses the focused button. Enter goes to the popup that is open (a save question with its answers
    // in its body, focus on neither): it would press the popup's default answer, still a commit, said as such.
    const space = await webguiAssessInFrame(f, { do: "key", key: "Space" });
    expect(space.risk).toBe("commit");
    expect(space.reason).toContain("Delete item");
    for (const key of [0, "Enter"]) {
      const a = await webguiAssessInFrame(f, { do: "key", key });
      expect([key, a.risk]).toEqual([key, "commit"]);
      expect(a.reason).toContain("default answer of the popup");
    }
    await page.locator("#B2").focus(); // "Display item": safe, but the popup asks whether to save, so Enter stays a commit
    expect((await webguiAssessInFrame(f, { do: "key", key: "Space" })).risk).toBe("navigate");
    await page.locator("#F1").focus();
    expect(await page.evaluate(focusedControl)).toMatchObject({ sid: "wnd[0]/usr/ctxtZHDR-TYPE", type: "GuiCTextField" });
    expect((await webguiAssessInFrame(f, { do: "key", key: "Space" })).risk).toBe("navigate");
    // Inside the HTML viewer: its button, then its link.
    await page.frameLocator("#V1").locator("#go").focus();
    expect(await page.evaluate(focusedControl)).toMatchObject({ sid: "wnd[0]/usr/cntlHTML/shellcont/shell", type: "frame" });
    expect((await webguiAssessInFrame(f, { do: "key", key: "Space" })).risk).toBe("commit"); // "Approve all"
    await page.frameLocator("#V1").locator("#l").focus();
    expect((await webguiAssessInFrame(f, { do: "key", key: "Space" })).risk).toBe("navigate"); // "Show details"
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  });

  test("Enter on a Yes / No popup with the focus on no answer presses nothing, and names the answers", async () => {
    const f = page.mainFrame();
    await page.locator("#F1").focus();
    const r = await refusal(webguiActInFrame(f, { do: "key", key: 0 }));
    expect(r).toContain("would press its default answer");
    expect(r).toContain('wnd[1]/usr/btnSPOP-OPTION1 "Yes"');
    expect(r).toContain('wnd[1]/usr/btnSPOP-OPTION2 "No"');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  });

  test("the logon page: nothing is read out, and every action is refused", async () => {
    const logon = await browser.newPage();
    await logon.setContent(
      `<html lang="en"><head><title>Logon</title></head><body><form name="loginForm"><input id="sap-user" name="sap-user" value="ME"><input id="sap-password" name="sap-password" type="password" value="hunter5"><input type="submit" id="LOGON_BUTTON" value="Log On" onclick="window.sent=1;return false"></form></body></html>`,
    );
    const f = logon.mainFrame();
    expect(await logon.evaluate(extractFacts)).toMatchObject({ webgui: false, logon: true });
    for (const action of [
      { do: "set", id: "sap-user", value: "X" },
      { do: "key", key: 0 },
      { do: "press", id: "LOGON_BUTTON" },
      { do: "okcode", value: "/nVA03" },
    ]) {
      expect(await refusal(webguiActInFrame(f, action))).toContain("This server never logs on; log on yourself, then ask again");
      expect(await refusal(webguiAssessInFrame(f, action))).toContain("This server never logs on; log on yourself, then ask again");
    }
    expect(await logon.locator("#sap-user").inputValue()).toBe("ME");
    expect(await logon.evaluate(() => (window as unknown as { sent?: number }).sent)).toBeUndefined();
    await logon.close();
  });

  test("the logon screen inside Web GUI (program SAPMSYST) is refused too, and its view holds no field", async () => {
    const inner = await browser.newPage();
    await inner.setContent(
      `<html lang="en"><body><div id="cuaheader" lsdata="{1:'SAP'}">SAP</div><input id="ToolbarOkCode" lsdata="{0:'x',20:${sid("wnd[0]/tbar[0]/okcd", "GuiOKCodeField")}}">
<input id="U" value="ME" lsdata="{0:'x',20:${sid("wnd[0]/usr/txtRSYST-BNAME", "GuiTextField")}}"><input id="P" type="password" value="hunter6" lsdata="{0:'x',20:${sid("wnd[0]/usr/pwdRSYST-BCODE", "GuiPasswordField")}}">
<div id="sysInfoAreaMenuItemSAPITS_MBAR_DYNPRO" lsdata="{0:'abc',1:'Screen',13:'SAPMSYST/0020'}"></div></body></html>`,
    );
    const f = inner.mainFrame();
    const view = (await webguiLookInFrame(f, false)) ?? "";
    expect(view).toContain("NOTE this is the SAP logon screen. This server never logs on");
    expect(view).not.toContain("hunter6");
    expect(view).not.toContain("RSYST");
    expect(await refusal(webguiActInFrame(f, { do: "set", id: "txtRSYST-BNAME", value: "X" }))).toContain("never logs on");
    expect(await refusal(webguiAssessInFrame(f, { do: "key", key: 0 }))).toContain("never logs on");
    expect(await inner.locator("#U").inputValue()).toBe("ME");
    await inner.close();
  });

  test("the logon language comes from the address, then from the page", async () => {
    expect((await page.evaluate(extractFacts)).language).toBe("en");
    const other = await browser.newPage();
    await other.route("**/*", (r) => r.fulfill({ contentType: "text/html", body: '<html lang="en"><body><input id="ToolbarOkCode" lsdata="{0:\'x\'}"></body></html>' }));
    await other.goto("http://sap.test/sap/bc/gui/sap/its/webgui?sap-client=100&sap-language=JA");
    expect((await other.evaluate(extractFacts)).language).toBe("JA");
    await other.close();
  });

  test("a page that is not Web GUI gives null", async () => {
    const other = await browser.newPage();
    await other.setContent("<html><body><input id='q'></body></html>");
    expect(await webguiLookInFrame(other.mainFrame(), true)).toBeNull();
    await other.close();
  });
});

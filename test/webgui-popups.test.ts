/**
 * What the reader says about the window in front (src/webgui/popups.ts), and
 * actions on a control behind a popup, on a synthetic page with Web GUI's
 * markup (a popup window and the layer it draws over the windows behind it).
 *
 * The browser part needs a Chrome: SAP_TEST_CHROME=/path/to/chrome.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveId } from "../src/core/ids.js";
import { ActionError } from "../src/core/types.js";
import { webguiLookInFrame } from "../src/webgui/index.js";
import { markControl, normalizeLsdata } from "../src/webgui/page.js";
import { behindPopup, closedByMessage, popupName, statusMessage, terminationIn, topPopup } from "../src/webgui/popups.js";
import { act } from "../src/webgui/reader.js";
import { WebGuiSession } from "../src/webgui/session.js";

const VIEW = [
  "TRANSACTION VL01N  PROGRAM SAPMV50A  SCREEN 1000",
  'WINDOW wnd[0]  "Create Outbound Delivery"',
  "wnd[0]/tbar[0]/btn[11]  button  Save (Ctrl+S)",
  "wnd[0]/tbar[0]/btn[12]  button  Cancel (Escape)",
  'wnd[0]/usr/ctxtLIKP-WADAT  field  Pl. GI date = "17.11.2026"  (edit)',
  'WINDOW wnd[1]  "Exit delivery processing"',
  "wnd[1]/usr/txtSPOP-TEXTLINE1  label  Do you wish to save your data first?",
  "wnd[1]/usr/btnSPOP-OPTION1  button  Yes",
  "wnd[1]/usr/btnSPOP-OPTION2  button  No",
  "wnd[1]/usr/btnSPOP-OPTION_CAN  button  Cancel",
].join("\n");

describe("the popup in front, from the view", () => {
  test("the window in front is the popup with the highest number", () => {
    expect(topPopup(VIEW)).toMatchObject({ n: 1, title: "Exit delivery processing" });
    expect(topPopup(VIEW.split("\nWINDOW wnd[1]")[0] as string)).toBeUndefined();
    expect(topPopup(`${VIEW}\nWINDOW wnd[2]  "Information"\nwnd[2]/tbar[0]/btn[0]  button  Continue (Enter)`)).toMatchObject({ n: 2, title: "Information" });
  });

  test("a control behind the popup is refused with the popup and its buttons", () => {
    const why = behindPopup(VIEW, "wnd[0]/tbar[0]/btn[11]", "press") ?? "";
    expect(why).toContain("wnd[0]/tbar[0]/btn[11] is behind a popup");
    expect(why).toContain('wnd[1] "Exit delivery processing"');
    expect(why).toContain('btnSPOP-OPTION1 "Yes", btnSPOP-OPTION2 "No", btnSPOP-OPTION_CAN "Cancel"');
    expect(why).not.toContain("read-only");
    // A control of the popup itself, a handle without a window, and a screen without a popup are not refused.
    expect(behindPopup(VIEW, "wnd[1]/usr/btnSPOP-OPTION1", "press")).toBeUndefined();
    expect(behindPopup(VIEW, "html[3]", "press")).toBeUndefined();
    expect(behindPopup(VIEW.split("\nWINDOW wnd[1]")[0] as string, "wnd[0]/tbar[0]/btn[11]", "press")).toBeUndefined();
  });

  test("the popup's name lists its buttons by the handles of the view", () => {
    expect(popupName(VIEW, topPopup(VIEW)!)).toBe('wnd[1] "Exit delivery processing" (its buttons: btnSPOP-OPTION1 "Yes", btnSPOP-OPTION2 "No", btnSPOP-OPTION_CAN "Cancel")');
  });

  test("an id that names a window never means a control of another window", () => {
    const ids = VIEW.split("\n").filter((l) => l.startsWith("wnd[")).map((l) => l.split("  ")[0] as string);
    // The popup has no btn[12]: the main window's Cancel is not what the id means.
    expect(resolveId(ids, "wnd[1]/tbar[0]/btn[12]")).toEqual({ none: true });
    // A wrong path inside the right window is still found by its last segment.
    expect(resolveId(ids, "wnd[1]/tbar[0]/btnSPOP-OPTION2")).toEqual({ id: "wnd[1]/usr/btnSPOP-OPTION2" });
    expect(resolveId(ids, "wnd[0]/usr/btn[12]")).toEqual({ id: "wnd[0]/tbar[0]/btn[12]" });
    // A handle without a window still means the control of the window in front.
    expect(resolveId([...ids, "wnd[1]/tbar[0]/btn[12]"], "btn[12]")).toEqual({ id: "wnd[1]/tbar[0]/btn[12]" });
  });
});

describe("messages, from the view", () => {
  const closed = [
    "TRANSACTION VA01  PROGRAM SAPMV45A  SCREEN 4001",
    'WINDOW wnd[0]  "Create Standard Order: Overview"',
    'wnd[0]/usr/ctxtVBKD-BSTDK  field  PO date = "20.11.2026"  (read-only)',
    'wnd[0]/usr/ctxtRV45A-MABNR[1,0]  field  Material = ""  (read-only)',
    "wnd[0]/sbar  status  W: The purchase order date lies in the future. Please check",
  ].join("\n");

  test("a warning that closed the fields: the reason says that Enter accepts it", () => {
    expect(statusMessage(closed)).toEqual({ type: "W", text: "The purchase order date lies in the future. Please check" });
    const why = closedByMessage(closed) ?? "";
    expect(why).toContain('the warning "The purchase order date lies in the future. Please check"');
    expect(why).toContain("Enter");
  });

  test("an error leaves the wrong field open: the reason points at it", () => {
    const error = closed.replace("W: The purchase", "E: The purchase").replace('"20.11.2026"  (read-only)', '"20.11.2026"  (edit)  (cursor here)');
    expect(closedByMessage(error)).toContain("cursor here");
  });

  test("a screen that still has open fields, or no warning, is read-only by itself", () => {
    expect(closedByMessage(closed.replace(/\(read-only\)/g, "(edit)"))).toBeUndefined();
    expect(closedByMessage(closed.replace("W: ", "S: "))).toBeUndefined();
  });

  test("a termination message is found in the popup in front", () => {
    const view = [
      "TRANSACTION VA01  PROGRAM SAPMV45A  SCREEN 4001",
      'WINDOW wnd[0]  "Create Standard Order: Overview"',
      'WINDOW wnd[1]  "Cancel"',
      "wnd[1]/usr/txtMESSTXT1  label  A: Date 17.11.2026 is after the end of factory calendar AM  (termination message: SAP ends the transaction when it is confirmed, and unsaved input is lost)",
      "wnd[1]/tbar[0]/btn[0]  button  Exit (Enter)",
    ].join("\n");
    expect(terminationIn(view)).toBe("Date 17.11.2026 is after the end of factory calendar AM");
    expect(terminationIn(VIEW)).toBeUndefined();
  });
});

const exe = process.env.SAP_TEST_CHROME;
const sid = (id: string, type: string, modal = 0) => `{ModalNo:${modal},SID:'${id}',Type:'${type}'}`;
// A screen with a question popup: Web GUI draws a layer over the main window, which takes every click.
const PAGE = `<!doctype html><html lang="en"><head><title>Synthetic</title></head><body>
<div id="cuaheader" lsdata="{1:'Create\\x20Synthetic\\x20Delivery'}">Create Synthetic Delivery</div>
<input id="ToolbarOkCode" lsdata="{0:'FREETEXT',20:${sid("wnd[0]/tbar[0]/okcd", "GuiOKCodeField")}}">
<div id="SAVE" title="Save (Ctrl+S)" onclick="window.saved=1" lsdata="{0:'Save',28:${sid("wnd[0]/tbar[0]/btn[11]", "GuiButton")}}">Save</div>
<div id="CANCEL" title="Cancel (Escape)" onclick="window.cancelled=1" lsdata="{0:'Cancel',28:${sid("wnd[0]/tbar[0]/btn[12]", "GuiButton")}}">Cancel</div>
<input id="F1" title="Pl. GI date" value="16.11.2026" lsdata="{0:'x',20:${sid("wnd[0]/usr/ctxtZLIKP-WADAT", "GuiCTextField")}}">
<div id="urPopupWindowBlockLayer" style="position:fixed;left:0;top:0;width:100%;height:100%;z-index:5"></div>
<div ct="PW" id="P1" style="position:absolute;z-index:6;top:200px;left:20px;width:400px" lsdata="{0:'x',5:${sid("wnd[1]", "GuiModalWindow", 1)}}"><span class="urPWTitleText" id="P1-ttltxt">Exit delivery processing</span>
<span lsdata="{1:'',3:'Do\\x20you\\x20wish\\x20to\\x20save\\x20your\\x20data\\x20first?',19:${sid("wnd[1]/usr/txtSPOP-TEXTLINE1", "GuiLabel", 1)}}">Do you wish to save your data first?</span>
<div tabindex="0" onclick="window.yes=1" lsdata="{0:'Yes',28:${sid("wnd[1]/usr/btnSPOP-OPTION1", "GuiButton", 1)}}">Yes</div>
<div tabindex="0" onclick="window.no=1" lsdata="{0:'No',28:${sid("wnd[1]/usr/btnSPOP-OPTION2", "GuiButton", 1)}}">No</div></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_TRANSACTION" lsdata="{13:'ZT01'}"></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_DYNPRO" lsdata="{13:'ZPROG/0100'}"></div>
</body></html>`;

describe.skipIf(!exe)("actions on a control behind a popup, in a browser", () => {
  let browser: Browser;
  let page: Page;
  let session: WebGuiSession;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: exe as string, headless: true, args: ["--no-sandbox"] });
    page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    await page.route("**/*", (r) => r.fulfill({ contentType: "text/html", body: PAGE }));
    await page.goto("http://sap.test/sap/bc/gui/sap/its/webgui?sap-client=100");
    session = new WebGuiSession(page.mainFrame());
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });
  const refused = async (action: Parameters<typeof act>[1]): Promise<{ message: string; ms: number }> => {
    const t0 = Date.now();
    try {
      await act(session, action);
    } catch (e) {
      expect(e).toBeInstanceOf(ActionError);
      return { message: (e as Error).message, ms: Date.now() - t0 };
    }
    throw new Error("the action ran");
  };

  test("press, set and a short handle behind the popup are refused at once, with the popup named", async () => {
    for (const action of [
      { do: "press", id: "wnd[0]/tbar[0]/btn[11]" },
      { do: "press", id: "btn[11]" },
      { do: "set", id: "ctxtZLIKP-WADAT", value: "17.11.2026" },
      { do: "select", id: "wnd[0]/mbar/menu[0]/menu[1]" },
    ]) {
      const r = await refused(action);
      expect(r.message).toContain("is behind a popup");
      expect(r.message).toContain('wnd[1] "Exit delivery processing" (its buttons: btnSPOP-OPTION1 "Yes", btnSPOP-OPTION2 "No")');
      expect(r.message).not.toContain("Timeout");
      expect(r.message).not.toContain("read-only");
      expect(r.ms).toBeLessThan(3000);
    }
    expect(await page.evaluate(() => (window as unknown as { saved?: number }).saved)).toBeUndefined();
    expect(await page.inputValue("#F1")).toBe("16.11.2026");
  });

  test("an id of the popup that the popup does not have is not a control of the main window", async () => {
    await page.evaluate(normalizeLsdata);
    expect(await page.evaluate(markControl, "wnd[1]/tbar[0]/btn[12]")).toBe("no control named wnd[1]/tbar[0]/btn[12]");
    expect(await page.evaluate(markControl, "wnd[1]/tbar[0]/btnSPOP-OPTION2")).toMatchObject({ sid: "wnd[1]/usr/btnSPOP-OPTION2" });
    const r = await refused({ do: "press", id: "wnd[1]/tbar[0]/btn[12]" });
    expect(r.message).toContain('No control "wnd[1]/tbar[0]/btn[12]" on this screen');
    expect(r.ms).toBeLessThan(3000);
    expect(await page.evaluate(() => (window as unknown as { cancelled?: number }).cancelled)).toBeUndefined();
  });

  test("a control of the popup is pressed", async () => {
    expect(await act(session, { do: "press", id: "btnSPOP-OPTION2" })).toContain("pressed wnd[1]/usr/btnSPOP-OPTION2");
    expect(await page.evaluate(() => (window as unknown as { no?: number }).no)).toBe(1);
  });
});

// SAP's message popup for a termination message (type A), as Web GUI of ECC draws it (read on 2026-11-16):
// an icon label (txtIK1) whose image names the type, and the text cut over MESSTXT1 and MESSTXT2.
const ABORT = `<!doctype html><html lang="en"><head><title>Synthetic</title></head><body>
<div id="cuaheader" lsdata="{1:'Create\\x20Synthetic\\x20Order'}">Create Synthetic Order</div>
<input id="ToolbarOkCode" lsdata="{0:'FREETEXT',20:${sid("wnd[0]/tbar[0]/okcd", "GuiOKCodeField")}}">
<input id="F1" title="Sold-To Party" value="1000" lsdata="{0:'x',20:${sid("wnd[0]/usr/ctxtZKUAGV-KUNNR", "GuiCTextField")}}">
<div id="urPopupWindowBlockLayer" style="position:fixed;left:0;top:0;width:100%;height:100%;z-index:5"></div>
<div ct="PW" id="SAPMSDYP10_1" style="position:absolute;z-index:6;top:200px;left:20px;width:400px" lsdata="{0:'x',13:${sid("wnd[1]", "GuiModalWindow", 1)}}"><span class="urPWTitleText" id="SAPMSDYP10_1-ttltxt">Cancel</span>
<span ct="L" title="Critical message" lsdata="{0:'Critical\\x20message',19:${sid("wnd[1]/usr/txtIK1", "GuiLabel", 1)}}"><img src="/sap/public/icons/ltr/s_m_crit.png" title="Critical message" style="width:16px;height:16px"></span>
<span ct="L" lsdata="{3:'Date\\x2017.11.2026\\x20is\\x20after\\x20the\\x20end\\x20of\\x20factory',19:${sid("wnd[1]/usr/txtMESSTXT1", "GuiLabel", 1)}}">Date 17.11.2026 is after the end of factory</span>
<span ct="L" lsdata="{3:'calendar\\x20AM',19:${sid("wnd[1]/usr/txtMESSTXT2", "GuiLabel", 1)}}">calendar AM</span>
<div tabindex="0" title="Exit (Enter)" onclick="exit()" lsdata="{0:'Exit',28:${sid("wnd[1]/tbar[0]/btn[0]", "GuiButton", 1)}}">Exit</div></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_TRANSACTION" lsdata="{13:'ZT01'}"></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_DYNPRO" lsdata="{13:'ZPROG/0100'}"></div>
<script>
  window.oLS = { n: 0, bLocked: function () { return this.n > 0; } };
  // Exit: SAP ends the transaction and shows its start screen.
  function exit() {
    window.oLS.n++;
    fetch('/sap/bc/gui/sap/its/webgui/post', { method: 'POST', body: JSON.stringify([{ post: 'vkey/0/ses[0]' }]) }).then(function () {
      document.getElementById('SAPMSDYP10_1').remove();
      document.getElementById('urPopupWindowBlockLayer').remove();
      document.getElementById('F1').remove();
      document.getElementById('sysInfoAreaMenuItemSAPITS_MBAR_TRANSACTION').setAttribute('lsdata', "{13:'S000'}");
      document.getElementById('sysInfoAreaMenuItemSAPITS_MBAR_TRANSACTION').removeAttribute('data-ls');
      window.oLS.n--;
    });
  }
</script>
</body></html>`;

describe.skipIf(!exe)("a termination message, in a browser", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: exe as string, headless: true, args: ["--no-sandbox"] });
    page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    await page.route("**/*", (r) => (r.request().method() === "POST" ? r.fulfill({ contentType: "text/plain", body: "ok" }) : r.fulfill({ contentType: "text/html", body: ABORT })));
    await page.goto("http://sap.test/sap/bc/gui/sap/its/webgui?sap-client=100");
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  test("the popup's message is one line with its type, marked as a termination; confirming it says the transaction ended", async () => {
    const view = (await webguiLookInFrame(page.mainFrame(), false)) ?? "";
    expect(view).toContain(
      "wnd[1]/usr/txtMESSTXT1  label  A: Date 17.11.2026 is after the end of factory calendar AM  (termination message: SAP ends the transaction when it is confirmed, and unsaved input is lost)",
    );
    expect(view).not.toContain("txtMESSTXT2");
    const note = await act(new WebGuiSession(page.mainFrame()), { do: "key", key: 0 });
    expect(note).toContain('key Enter (pressed wnd[1]/tbar[0]/btn[0] "Exit (Enter)")');
    expect(note).toContain('SAP ended transaction ZT01 after the termination message "Date 17.11.2026 is after the end of factory calendar AM": input that was not saved there is lost.');
  }, 30_000);
});

// A warning in the status bar: SAP has closed every field of the screen until Enter accepts it.
const WARNED = `<!doctype html><html lang="en"><head><title>Synthetic</title></head><body>
<div id="cuaheader" lsdata="{1:'Create\\x20Synthetic\\x20Order'}">Create Synthetic Order</div>
<input id="ToolbarOkCode" lsdata="{0:'FREETEXT',20:${sid("wnd[0]/tbar[0]/okcd", "GuiOKCodeField")}}">
<span class="lsField lsField--readonly"><input id="F1" title="PO date" value="20.11.2026" readonly lsdata="{0:'x',20:${sid("wnd[0]/usr/ctxtZVBKD-BSTDK", "GuiCTextField")}}"></span>
<span class="lsField lsField--readonly"><input id="F2" title="Material" value="" readonly lsdata="{0:'x',20:${sid("wnd[0]/usr/ctxtZRV45A-MABNR", "GuiCTextField")}}"></span>
<table id="grid#9" ct="STCS" lsdata="{29:{ColumnIDs:['MATNR','WERKS'],${sid("wnd[0]/usr/cntlGRID1/shellcont/shell", "GuiGridView").slice(1)}}" style="width:300px">
  <thead><tr><th lsmatrixrowindex="0" lsmatrixcolindex="0" lsdata="{7:'Material',17:${sid("wnd[0]/usr/cntlGRID1/shellcont/shell/colMATNR", "GuiTableColumn")}}">Material</th>
    <th lsmatrixrowindex="0" lsmatrixcolindex="1" lsdata="{7:'Plant',17:${sid("wnd[0]/usr/cntlGRID1/shellcont/shell/colWERKS", "GuiTableColumn")}}">Plant</th></tr></thead>
</table>
<div id="grid#9_vscroll" ct="SCB" style="width:16px;height:40px" lsdata="{0:1,3:10,6:'grid\\x239',10:0}">&nbsp;</div>
<table id="msgarea" lsdata="{0:'32px',6:${sid("wnd[0]/sbar", "GuiStatusBar")}}" style="width:900px"><tr>
<td><div id="wnd[0]/sbar_msg" ct="MB" lsdata="{0:'The\\x20purchase\\x20order\\x20date\\x20lies\\x20in\\x20the\\x20future',1:'WARNING',11:{applicationText:'The purchase  order date lies in the future'}}"><span id="wnd[0]/sbar_msg-txt" onclick="msgClick(this)">The purchase &nbsp;order date lies in the future</span></div></td>
<td style="width:500px"><img id="LOGO" alt="Service Request" style="width:38px;height:20px" ondblclick="window.support=1"></td></tr></table>
<script>
  window.oLS = { n: 0, bLocked: function () { return this.n > 0; } };
  // Web GUI sends the click on the message only when the text it drew is the text SAP sent.
  function msgClick(span) {
    if (span.innerHTML !== 'The purchase  order date lies in the future') { window.held = 1; return; }
    window.oLS.n++;
    fetch('/sap/bc/gui/sap/its/webgui/post', { method: 'POST', body: JSON.stringify([{ post: 'action/1/wnd[0]/sbar' }]) }).then(function () { window.help = 1; window.oLS.n--; });
  }
</script>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_TRANSACTION" lsdata="{13:'ZT01'}"></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_DYNPRO" lsdata="{13:'ZPROG/0100'}"></div>
</body></html>`;

describe.skipIf(!exe)("a warning in the status bar and an empty grid, in a browser", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: exe as string, headless: true, args: ["--no-sandbox"] });
    page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    await page.route("**/*", (r) => (r.request().method() === "POST" ? r.fulfill({ contentType: "text/plain", body: "ok" }) : r.fulfill({ contentType: "text/html", body: WARNED })));
    await page.goto("http://sap.test/sap/bc/gui/sap/its/webgui?sap-client=100");
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  test("set is refused with the warning as the reason, and Enter as the way on", async () => {
    const e = await act(new WebGuiSession(page.mainFrame()), { do: "set", id: "ctxtZRV45A-MABNR", value: "M-01" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ActionError);
    expect((e as Error).message).toBe(
      'wnd[0]/usr/ctxtZRV45A-MABNR is read-only for now: SAP shows the warning "The purchase order date lies in the future" and keeps the fields closed until it is answered: Enter ({"do":"key","key":0}) accepts the warning, then the fields open again.',
    );
  }, 30_000);

  test("a grid without rows keeps its columns and says that it is empty", async () => {
    const view = (await webguiLookInFrame(page.mainFrame(), false)) ?? "";
    expect(view).toContain("wnd[0]/usr/cntlGRID1/shellcont/shell  grid  0 rows (the list is empty: SAP found no data for it); columns: MATNR=Material | WERKS=Plant");
  }, 30_000);

  test("press on the status bar clicks its message, which opens the long text; never the logo beside it", async () => {
    for (const action of [{ do: "press", id: "sbar" }, { do: "dblclick", id: "wnd[0]/sbar" }]) {
      await page.evaluate(() => Object.assign(window, { help: 0 }));
      expect(await act(new WebGuiSession(page.mainFrame()), action)).toContain("clicked the message of wnd[0]/sbar");
      expect(await page.evaluate(() => (window as unknown as { help?: number }).help)).toBe(1);
    }
    // The click was not held back (the text was drawn with "&nbsp;"), and the support message was not started.
    expect(await page.evaluate(() => [(window as unknown as { held?: number }).held, (window as unknown as { support?: number }).support])).toEqual([undefined, undefined]);
  }, 30_000);
});

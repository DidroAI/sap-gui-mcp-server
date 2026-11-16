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
});

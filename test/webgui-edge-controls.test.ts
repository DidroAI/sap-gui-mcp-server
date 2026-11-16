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
      'set wnd[0]/usr/ctxtZHDR-TYPE (the field takes 4 characters: it holds "ORDE", the last 1 of the 5 typed are cut)',
    );
    expect(await webguiActInFrame(f, { do: "set", id: "ctxtZHDR-TYPE", value: "OR" })).toBe("set wnd[0]/usr/ctxtZHDR-TYPE");
  });

  test("ECCSCR-06: the operator of a selection criterion, an icon before the field, is a line of the view", async () => {
    await show(SELOPT);
    const view = await full();
    expect(view).toContain('wnd[0]/usr/txt%_MATNR_%_APP_%-OPTI_PUSH  label  icon "Select: Not equal to"');
    expect(compact(view)).toContain('txt%_MATNR_%_APP_%-OPTI_PUSH  label  icon "Select: Not equal to"\nctxtMATNR-LOW  field  Material = "M-17"  (edit)');
  });
});

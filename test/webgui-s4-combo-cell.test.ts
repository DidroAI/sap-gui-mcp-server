/**
 * A dropdown cell of a table control as S/4HANA Web GUI draws it (MIRO's Tax Code, live 2026-11-22): no
 * input, but a text box span (ct CB, role textbox) that holds the SID, the key and the text in its lsdata,
 * and names its list box in aria-controls. The reader skipped it, so the column never showed; ECC draws
 * an input there. The page is made up, with no SAP data.
 *
 *   SAP_TEST_CHROME=/path/to/chrome bun test test/webgui-s4-combo-cell.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { webguiActInFrame, webguiLookInFrame } from "../src/webgui/index.js";

const exe = process.env.SAP_TEST_CHROME;
const SID = "wnd[0]/usr/tblZPROGTC_ITEMS/cmbZITEM-MWSKZ[8,0]";

const PAGE = `<!doctype html><html lang="en"><head><title>Synthetic</title></head><body>
<div id="cuaheader" lsdata="{1:'Synthetic\\x20invoice'}">Synthetic invoice</div>
<input id="ToolbarOkCode" lsdata="{0:'FREETEXT',20:{ModalNo:0,SID:'wnd[0]/tbar[0]/okcd',Type:'GuiOKCodeField'}}">
<table class="lsField lsField--table lsField--list" role="presentation"><tbody><tr><td class="lsField__inputcontainer">
<span role="textbox" aria-roledescription="Dropdown List Box" aria-controls="ZITEM-MWSKZZPROG_ei" readonly="" tabindex="0" id="T1[1,9]_c" ct="CB" class="lsField__input"
  lsdata="{3:'ZITEM-MWSKZZPROG_ei',4:'A0',5:'A0\\x20(Exempt)',7:true,12:true,21:{ModalNo:0,SID:'${SID}',Type:'GuiComboBox',focusable:'X'}}">A0 (Exempt)</span>
</td></tr></tbody></table>
<div id="ZITEM-MWSKZZPROG_ei" style="display:none"><div ct="LIB_I" data-itemkey="A0" lsdata="{4:'A0\\x20(Exempt)'}"></div><div ct="LIB_I" data-itemkey="A1" lsdata="{4:'A1\\x20(Taxable)'}"></div></div>
<div id="msgarea"><span ct="TV">XYZ (100)</span></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_SYSTEM" lsdata="{0:'abc',1:'System',13:'XYZ\\x20(100)'}"></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_TRANSACTION" lsdata="{13:'ZT20'}"></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_DYNPRO" lsdata="{13:'ZPROG/0100'}"></div>
</body></html>`;

describe.skipIf(!exe)("Web GUI reader: a dropdown cell drawn as a text box span (S/4HANA)", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: exe!, headless: true, args: ["--no-sandbox"] });
    page = await browser.newPage();
    await page.setContent(PAGE);
  });
  afterAll(async () => {
    await browser?.close();
  });

  test("the cell is listed as a dropdown, with its key, its text and its entries", async () => {
    const full = ((await webguiLookInFrame(page.mainFrame(), false)) ?? "").split("\n");
    const line = full.find((l) => l.startsWith(`${SID}  dropdown`));
    expect(line).toBeDefined();
    expect(line).toContain('= "A0" A0 (Exempt)  (edit)');
    expect(line).toContain("2 options: A0:A0 (Exempt), A1:A1 (Taxable)");
  });

  test("its entries are listed from its list box (combo without a key)", async () => {
    const out = await webguiActInFrame(page.mainFrame(), { do: "combo", id: SID });
    expect(out).toContain("has 2 entries");
    expect(out).toContain("A1:A1 (Taxable)");
  });
});

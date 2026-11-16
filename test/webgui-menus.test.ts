/**
 * The menu bar of Web GUI, on a synthetic page that behaves as Web GUI of
 * ECC does (measured on 2026-11-16): the Menu button is a toggle, a click on
 * it with the menu open closes the menu; each menu is a table of rows whose
 * DOM id is the scripting id; Escape closes the submenu that has the focus
 * and leaves the top level open; the menu also holds Web GUI's own entries
 * (file browser, Settings, About), which have no scripting id of their own.
 *
 * Needs a Chrome: SAP_TEST_CHROME=/path/to/chrome. Without it the tests are skipped.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { menuSid, shortIds } from "../src/core/ids.js";
import { ActionError } from "../src/core/types.js";
import { webguiLookInFrame } from "../src/webgui/index.js";
import { act, assess } from "../src/webgui/reader.js";
import { WebGuiSession } from "../src/webgui/session.js";

const exe = process.env.SAP_TEST_CHROME;
const sid = (id: string, type: string, modal = 0) => `{ModalNo:${modal},SID:'${id}',Type:'${type}'}`;
const M = "wnd[0]/mbar";
const rowOf = (id: string, text: string, sub = "") =>
  `<tr id="${id}" ct="POMNI" onclick="rowClick(this,'${sub}')" lsdata="{1:'${text.replace(/ /g, "\\\\x20")}',18:${sid(id, "GuiMenu")}}"><td>${text}</td></tr>`;
const tpl = (id: string, text: string) => `<tr lsdata="{1:'${text.replace(/ /g, "\\x20")}',18:${sid(id, "GuiMenu")}}"></tr>`;

const PAGE = `<!doctype html><html lang="en"><head><title>Synthetic</title></head><body>
<div id="cuaheader" lsdata="{1:'Synthetic\\x20menus'}">Synthetic menus</div>
<input id="ToolbarOkCode" lsdata="{0:'FREETEXT',20:${sid("wnd[0]/tbar[0]/okcd", "GuiOKCodeField")}}">
<div id="cua2sapmenu_btn" onclick="toggleMenu()" lsdata="{0:'Menu',28:{ModalNo:0,SID:'wnd[0]/tbar[0]/',SubType:'toolbar',Type:'GuiButton'}}">Menu</div>
<div title="Cancel (Escape)" onclick="window.cancelled=1" lsdata="{0:'Cancel',28:${sid("wnd[0]/tbar[0]/btn[12]", "GuiButton")}}">Cancel</div>
<table id="root" ct="POMN" class="mnu" style="display:none;position:absolute;top:60px;left:10px;background:#fff">
  ${rowOf(`${M}/menu[0]`, "Order", "sub0")}
  ${rowOf(`${M}/menu[1]`, "Goto", "sub1")}
  <tr id="mnuentryItsFileBrowser" ct="POMNI" lsdata="{1:'File\\x20Browser',18:${sid(`${M}/`, "GuiMenu")}}"><td>SAP GUI for HTML File Browser</td></tr>
  <tr id="mnuentryAbout" ct="POMNI" lsdata="{1:'About',18:${sid(`${M}/[2]`, "GuiMenu")}}"><td>About SAP GUI for HTML</td></tr>
</table>
<table id="sub0" ct="POMN" class="mnu" style="display:none;position:absolute;top:60px;left:260px;background:#fff">
  ${rowOf(`${M}/menu[0]/menu[0]`, "Display log")}
</table>
<table id="sub1" ct="POMN" class="mnu" style="display:none;position:absolute;top:60px;left:260px;background:#fff">
  ${rowOf(`${M}/menu[1]/menu[0]`, "Header", "sub10")}
  ${rowOf(`${M}/menu[1]/menu[1]`, "Overview")}
</table>
<table id="sub10" ct="POMN" class="mnu" style="display:none;position:absolute;top:60px;left:460px;background:#fff">
  ${rowOf(`${M}/menu[1]/menu[0]/menu[3]`, "Texts")}
</table>
<div class="lsMnu--root"><xmp><table lsdata="{6:${sid(M, "GuiMenu")}}">${tpl(`${M}/menu[0]`, "Order")}${tpl(`${M}/menu[1]`, "Goto")}</table></xmp>
<xmp><table>${tpl(`${M}/menu[0]/menu[0]`, "Display log")}${tpl(`${M}/menu[1]/menu[0]`, "Header")}${tpl(`${M}/menu[1]/menu[1]`, "Overview")}${tpl(`${M}/menu[1]/menu[0]/menu[3]`, "Texts")}</table></xmp></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_TRANSACTION" lsdata="{13:'ZT01'}"></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_DYNPRO" lsdata="{13:'ZPROG/0100'}"></div>
<script>
  window.oLS = { n: 0, bLocked: function () { return this.n > 0; } };
  var shown = [];
  function show(id, on) { document.getElementById(id).style.display = on ? 'table' : 'none'; }
  function closeAll() { ['root', 'sub0', 'sub1', 'sub10'].forEach(function (x) { show(x, false); }); shown = []; }
  // The Menu button is a toggle.
  function toggleMenu() { if (shown.length) closeAll(); else { show('root', true); shown = ['root']; } }
  // An entry with a submenu toggles it (the worst case: a second click closes it); a leaf is sent to SAP and the menu closes.
  function rowClick(tr, sub) {
    var own = tr.closest('table').id;
    if (sub) {
      var open = shown.indexOf(sub) >= 0;
      while (shown.length && shown[shown.length - 1] !== own) show(shown.pop(), false);
      if (!open) { show(sub, true); shown.push(sub); }
      return;
    }
    window.chosen = tr.id;
    closeAll();
    window.oLS.n++;
    fetch('/sap/bc/gui/sap/its/webgui/post', { method: 'POST', body: JSON.stringify([{ post: 'action/1/ses[0]' }]) }).then(function () { window.oLS.n--; });
  }
  // Escape closes the submenu that has the focus, and nothing else: the top level stays open.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (shown.length > 1) show(shown.pop(), false);
    else if (!shown.length) window.cancelled = 1;
  });
</script>
</body></html>`;

describe("menu handles", () => {
  test("a menu entry is named by its whole path below the menu bar", () => {
    const ids = [`${M}/menu[3]`, `${M}/menu[3]/menu[5]`, `${M}/menu[3]/menu[6]`, "wnd[0]/usr/btnX"];
    const h = shortIds(ids);
    expect(h.get(`${M}/menu[3]`)).toBe("menu[3]");
    expect(h.get(`${M}/menu[3]/menu[5]`)).toBe("menu[3]/menu[5]");
    // "menu[6]" alone would read as a top menu.
    expect(h.get(`${M}/menu[3]/menu[6]`)).toBe("menu[3]/menu[6]");
  });

  test("a menu entry can be named by its handle, from the menu bar, or by its whole id", () => {
    expect(menuSid("menu[4]/menu[10]")).toBe(`${M}/menu[4]/menu[10]`);
    expect(menuSid("mbar/menu[4]/menu[10]")).toBe(`${M}/menu[4]/menu[10]`);
    expect(menuSid(`${M}/menu[4]`)).toBe(`${M}/menu[4]`);
    expect(menuSid("mbar")).toBeUndefined();
    expect(menuSid("wnd[0]/usr/btnX")).toBeUndefined();
    expect(menuSid("wnd[0]/menu[1]")).toBeUndefined();
  });
});

describe.skipIf(!exe)("the menu bar, in a browser", () => {
  let browser: Browser;
  let page: Page;
  let session: WebGuiSession;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: exe as string, headless: true, args: ["--no-sandbox"] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });
  async function open(): Promise<void> {
    await page?.context().close();
    page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    await page.route("**/*", (r) => (r.request().method() === "POST" ? r.fulfill({ contentType: "text/plain", body: "ok" }) : r.fulfill({ contentType: "text/html", body: PAGE })));
    await page.goto("http://sap.test/sap/bc/gui/sap/its/webgui?sap-client=100");
    session = new WebGuiSession(page.mainFrame());
  }
  const chosen = () => page.evaluate(() => (window as unknown as { chosen?: string }).chosen);
  const menuLines = async () => ((await webguiLookInFrame(page.mainFrame(), true)) ?? "").split("\n").filter((l) => / {2}menu {2}/.test(l));

  test("open a menu, read it, choose an entry of it: the open menu is not closed first", async () => {
    await open();
    const note = await act(session, { do: "select", id: `${M}/menu[1]` });
    expect(note).toContain(`menu ${M}/menu[1] opened: its entries are in the view`);
    expect(note).toEndWith("nothing was sent to SAP)");
    // The entries carry their path; Web GUI's own entries are not listed.
    expect(await menuLines()).toEqual(["menu[0]  menu  Order", "menu[1]  menu  Goto", "menu[1]/menu[0]  menu  Header", "menu[1]/menu[1]  menu  Overview"]);
    const t0 = Date.now();
    expect(await act(session, { do: "select", id: "menu[1]/menu[1]" })).toBe(`menu ${M}/menu[1]/menu[1]`);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(await chosen()).toBe(`${M}/menu[1]/menu[1]`);
    expect(await menuLines()).toEqual([]);
  }, 30_000);

  test("a submenu is opened step by step, then its entry chosen", async () => {
    await open();
    await act(session, { do: "select", id: `${M}/menu[1]` });
    expect(await act(session, { do: "select", id: `${M}/menu[1]/menu[0]` })).toContain("opened");
    expect(await menuLines()).toContain("menu[1]/menu[0]/menu[3]  menu  Texts");
    expect(await act(session, { do: "select", id: `${M}/menu[1]/menu[0]/menu[3]` })).toBe(`menu ${M}/menu[1]/menu[0]/menu[3]`);
    expect(await chosen()).toBe(`${M}/menu[1]/menu[0]/menu[3]`);
  }, 30_000);

  test("the full path works from a closed menu, and with another menu open", async () => {
    await open();
    expect(await act(session, { do: "select", id: `${M}/menu[1]/menu[0]/menu[3]` })).toBe(`menu ${M}/menu[1]/menu[0]/menu[3]`);
    expect(await chosen()).toBe(`${M}/menu[1]/menu[0]/menu[3]`);
    await act(session, { do: "select", id: `${M}/menu[1]` });
    expect(await act(session, { do: "select", id: "menu[0]/menu[0]" })).toBe(`menu ${M}/menu[0]/menu[0]`);
    expect(await chosen()).toBe(`${M}/menu[0]/menu[0]`);
  }, 30_000);

  test("Escape closes the whole menu, also when Web GUI leaves its top level open; the next one is Cancel", async () => {
    await open();
    await act(session, { do: "select", id: `${M}/menu[1]` });
    expect(await act(session, { do: "key", key: "Escape" })).toBe("key Escape (closed the open menu; the screen under it is as it was, nothing was sent to SAP)");
    expect(await menuLines()).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { cancelled?: number }).cancelled)).toBeUndefined();
  }, 30_000);

  test("an entry the menu bar does not have is said at once", async () => {
    await open();
    const t0 = Date.now();
    const e = await act(session, { do: "select", id: `${M}/menu[1]/menu[7]` }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ActionError);
    expect((e as Error).message).toContain(`No menu entry "${M}/menu[1]/menu[7]" on this screen`);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(await menuLines()).toEqual([]);
  }, 30_000);

  // Measured on ECC: a menu that was opened once is no template any more, its rows stay in the page when it closes.
  test("after a menu was opened and closed, the menu bar is still in the view and its menus open", async () => {
    await open();
    await act(session, { do: "select", id: `${M}/menu[1]` });
    await act(session, { do: "select", id: `${M}/menu[1]/menu[0]` });
    await page.evaluate(() => document.querySelectorAll(".lsMnu--root xmp").forEach((x) => x.remove()));
    await act(session, { do: "key", key: "Escape" });
    const view = (await webguiLookInFrame(page.mainFrame(), true)) ?? "";
    expect(view).toContain('mbar  menubar  Order {menu[0]}, Goto {menu[1]}  (every entry and its path: look id "mbar")');
    expect(await act(session, { do: "select", id: `${M}/menu[0]` })).toContain("opened");
    // While the menu is open its rows are the "menu" lines: no second line for the menu bar.
    expect((await webguiLookInFrame(page.mainFrame(), true)) ?? "").not.toContain("menubar");
    await act(session, { do: "key", key: "Escape" });
    expect(await act(session, { do: "select", id: `${M}/menu[1]/menu[0]/menu[3]` })).toBe(`menu ${M}/menu[1]/menu[0]/menu[3]`);
    expect(await chosen()).toBe(`${M}/menu[1]/menu[0]/menu[3]`);
  }, 30_000);

  test("the guard judges an entry of another menu by its path while a menu is open", async () => {
    await open();
    await act(session, { do: "select", id: `${M}/menu[1]` });
    // "menu[0]" is also the last part of the open "menu[1]/menu[0]": the path is not read as a handle.
    expect((await assess(session, { do: "select", id: `${M}/menu[0]/menu[0]` })).risk).toBeDefined();
  }, 30_000);

  test("an entry named from the menu bar (mbar/menu[1]/menu[1]) is chosen as by its whole id", async () => {
    await open();
    expect(await act(session, { do: "select", id: "mbar/menu[1]/menu[1]" })).toBe(`menu ${M}/menu[1]/menu[1]`);
    expect(await chosen()).toBe(`${M}/menu[1]/menu[1]`);
  }, 30_000);
});

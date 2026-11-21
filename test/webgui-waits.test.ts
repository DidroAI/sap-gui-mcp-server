/**
 * The waits of a Web GUI action on a synthetic page that answers like Web
 * GUI: a key or a click sends one POST (or none), the page is locked
 * (`oLS.bLocked()`) until the answer is in. It needs a Chrome to run in:
 *
 *   SAP_TEST_CHROME=/path/to/chrome bun test test/webgui-waits.test.ts
 *
 * Without SAP_TEST_CHROME the tests are skipped. No SAP data: the page is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { ActionError } from "../src/core/types.js";
import { STILL_WORKING, webguiView } from "../src/webgui/index.js";
import { act, nothingSent, vkey } from "../src/webgui/reader.js";
import { extractEnded, WebGuiSession } from "../src/webgui/session.js";

const exe = process.env.SAP_TEST_CHROME;
const sid = (id: string, type: string, modal = 0) => `{ModalNo:${modal},SID:'${id}',Type:'${type}'}`;
const URL_ = "http://sap.test/sap/bc/gui/sap/its/webgui?sap-client=100";

const PAGE = `<!doctype html><html lang="en"><head><title>Synthetic</title></head><body>
<div id="cuaheader" lsdata="{1:'Synthetic\\x20screen'}">Synthetic screen</div>
<input id="ToolbarOkCode" lsdata="{0:'FREETEXT',20:${sid("wnd[0]/tbar[0]/okcd", "GuiOKCodeField")}}">
<div id="CANCEL" title="Cancel (F12)" onclick="post('vkey/12')" lsdata="{0:'Cancel',19:'F12',28:${sid("wnd[0]/tbar[0]/btn[12]", "GuiButton")}}">Cancel</div>
<label id="L1" lsdata="{1:'F1',3:'Order',19:${sid("wnd[0]/usr/lblZ-ORDER", "GuiLabel")}}">Order</label>
<input id="F1" value="" lsdata="{0:'x',20:${sid("wnd[0]/usr/ctxtZ-ORDER", "GuiCTextField")}}">
<div id="sysInfoAreaMenuItemSAPITS_MBAR_TRANSACTION" lsdata="{13:'ZT01'}"></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_DYNPRO" lsdata="{13:'ZPROG/0100'}"></div>
<div ct="PW" id="P1" style="display:none" lsdata="{0:'x',5:${sid("wnd[1]", "GuiModalWindow", 1)}}"><span class="urPWTitleText">Partner selection</span>
<div id="ROW" ct="ALT" lsdata="{2:${sid("wnd[1]/usr/lbl[4,5]", "ABAPLISTTEXT", 1)}}">1000 Becker Berlin</div></div>
<table id="CTX" style="position:absolute;top:-9999px;left:20px"><tr ct="POMN" id="u1"><td>Copy text</td></tr><tr ct="POMN" id="u2"><td>Paste</td></tr></table>
<div id="LIST" ct="LIB" class="lsListbox" style="display:none;position:absolute;top:120px;left:20px;width:80px;height:40px">A B</div>
<script>
  window.posted = [];
  // Escape with a menu or a list open closes it and goes no further, as in Web GUI.
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var ctx = document.getElementById('CTX'), list = document.getElementById('LIST');
    if (ctx.style.top !== '-9999px') { ctx.style.top = '-9999px'; e.stopImmediatePropagation(); }
    else if (list.style.display !== 'none') { list.style.display = 'none'; e.stopImmediatePropagation(); }
  }, true);
  window.oLS = { n: 0, bLocked: function () { return this.n > 0 || window.stuck === true; } };
  function post(what, then) {
    window.oLS.n++;
    window.posted.push(what);
    fetch('/sap/bc/gui/sap/its/webgui/post', { method: 'POST', body: JSON.stringify([{ post: what + '/ses[0]' }]) })
      .then(function () {
        window.oLS.n--;
        // The answer makes the page ask for more (a grid's rows): a second round trip, through the queue.
        if (then) window.UCF_System.oLS.oSemanticEventHandlerObject.enqueueEvent({ sEvName: 'RequestData', post: then });
      });
  }
  // Web GUI's event queue, as with SAP Screen Personas on: a step waits 300 ms in it before it is sent.
  window.makeQueue = function () {
    var q = [], timer = null;
    var owner = {
      enqueueEvent: function (ev) {
        if (window.oLS.bLocked() && ev.sEvName !== 'RequestData') return;
        if (ev.sEvName === 'FocusChange') return;
        q.push(ev);
        if (!timer) timer = setTimeout(function () { owner.processEventQueue(true); }, 300);
      },
      processEventQueue: function () { timer = null; var ev; while ((ev = q.shift())) if (ev.post) post(ev.post, ev.then); }
    };
    window.UCF_System = { oLS: { oSemanticEventHandlerObject: owner } };
    window.UCF_JsUtil = { mDelayedCalls: {} };
    window.queued = true;
  };
  document.addEventListener('keydown', function (e) {
    // A request that leaves after the queue was seen empty (live 2026-11-20: VA03's first Enter after a logon).
    if (e.key === 'Enter' && window.queued && window.outsideQueue) { setTimeout(function () { post('vkey/0'); }, 200); return; }
    if (window.queued) {
      var owner = window.UCF_System.oLS.oSemanticEventHandlerObject;
      if (e.key === 'Enter') owner.enqueueEvent({ sEvName: 'Hotkey', post: 'vkey/0' });
      if (e.key === 'F8') owner.enqueueEvent({ sEvName: 'Hotkey', post: 'vkey/8', then: 'action/rows' });
      // A field that scrolls into view tells SAP 200 ms later; here that sends nothing.
      if (e.key === 'F7') { window.UCF_JsUtil.mDelayedCalls.d1 = { sMethodName: 'fireScrollSync' }; setTimeout(function () { delete window.UCF_JsUtil.mDelayedCalls.d1; owner.enqueueEvent({ sEvName: 'Scroll', post: 'action/scroll' }); }, 200); }
      return;
    }
    if (e.key === 'Enter' && window.lateEnter) { setTimeout(function () { post('vkey/0'); }, 300); return; }
    if (e.key === 'Enter') {
      if (window.endOnEnter) {
        window.stuck = true;
        document.body.innerHTML = '<p>Goodbye. You have been logged off.</p>';
        return;
      }
      if (window.busyEnter) { var t = Date.now(); while (Date.now() - t < 600) {} }
      setTimeout(function () { post('vkey/0'); }, 40);
    }
    // F2 does nothing on this screen, as on many SAP screens.
  });
  // In the popup's list the first double-click only gives the list the cursor; the next one chooses.
  document.getElementById('ROW').addEventListener('dblclick', function () {
    if (!window.cursor) { window.cursor = true; return; }
    post('action/dblclick');
    document.getElementById('P1').style.display = 'none';
  });
</script>
</body></html>`;

describe.skipIf(!exe)("waits of a Web GUI action", () => {
  let browser: Browser;
  let page: Page;
  let session: WebGuiSession;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: exe as string, headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function open(): Promise<void> {
    page = await (await browser.newContext()).newPage();
    await page.route("**/*", async (r) => {
      if (r.request().method() === "POST") {
        await new Promise((x) => setTimeout(x, 200));
        return r.fulfill({ contentType: "text/plain", body: "ok" });
      }
      return r.fulfill({ contentType: "text/html", body: PAGE });
    });
    await page.goto(URL_);
    session = new WebGuiSession(page.mainFrame());
  }

  const timed = async (f: () => Promise<string>) => {
    const t0 = Date.now();
    const note = await f();
    return { note, ms: Date.now() - t0 };
  };

  test("a key that sends nothing answers at once and says so", async () => {
    await open();
    const r = await timed(() => act(session, { do: "key", key: 2 }));
    expect(r.note).toBe("key F2\nNothing was sent to SAP: this key does nothing on this screen (or the browser kept it). The screen is as it was.");
    // It waited 5 s before.
    expect(r.ms).toBeLessThan(1500);
  });

  test("a key whose request leaves a moment later is waited for, with SAP's part measured", async () => {
    await open();
    const r = await timed(() => act(session, { do: "key", key: 0 }));
    expect(r.note).toBe("key Enter");
    expect(await page.evaluate(() => (window as unknown as { posted: string[] }).posted)).toEqual(["vkey/0"]);
    expect(session.timing.posts).toBe(1);
    expect(session.timing.sap).toBeGreaterThanOrEqual(150);
    expect(session.timingText).toMatch(/^\d+ ms: sap \d+, start \d+, settle \d+, wake \d+, other \d+ \(1 request\)$/);
  });

  test("a page busy with the key is waited for: its request leaves after it has drawn again", async () => {
    await open();
    await page.evaluate(() => {
      (window as unknown as { busyEnter: boolean }).busyEnter = true;
    });
    const r = await timed(() => act(session, { do: "key", key: 0 }));
    expect(r.note).toBe("key Enter");
    expect(session.started).toBe(true);
  });

  const posted = () => page.evaluate(() => (window as unknown as { posted: string[] }).posted);

  test("a step Web GUI holds 300 ms in its event queue is waited for, never answered as nothing sent", async () => {
    await open();
    await page.evaluate(() => (window as unknown as { makeQueue: () => void }).makeQueue());
    for (let i = 0; i < 5; i++) {
      const r = await timed(() => act(session, { do: "key", key: 0, timing: true }));
      expect(r.note).toBe("key Enter");
      expect(session.started).toBe(true);
      // The request left 300 ms after the key: "start" is the wait for it.
      expect(session.timing.start).toBeGreaterThanOrEqual(250);
    }
    expect(await posted()).toEqual(["vkey/0", "vkey/0", "vkey/0", "vkey/0", "vkey/0"]);
  });

  test("with the queue watched, the step is over when the page is unlocked and the queue is empty: no 300 ms of quiet", async () => {
    await open();
    await page.evaluate(() => (window as unknown as { makeQueue: () => void }).makeQueue());
    const settles: number[] = [];
    for (let i = 0; i < 5; i++) {
      expect(await act(session, { do: "key", key: 0 })).toBe("key Enter");
      settles.push(session.timing.settle);
    }
    // It was 300 ms and more each time.
    expect(settles.sort((a, b) => a - b)[2]).toBeLessThan(200);
  });

  test("with the queue watched, typing into a field waits for no quiet period", async () => {
    await open();
    await page.evaluate(() => (window as unknown as { makeQueue: () => void }).makeQueue());
    // Right after an answer: the 300 ms of quiet since the last request are not waited for.
    await act(session, { do: "key", key: 0 });
    expect(await act(session, { do: "set", id: "ctxtZ-ORDER", value: "4990" })).toBe("set wnd[0]/usr/ctxtZ-ORDER");
    expect(await page.locator("#F1").inputValue()).toBe("4990");
    expect(session.timing.idle).toBeLessThan(100);
    // Where the queue is not watched, the lead and the quiet period stay.
    await open();
    await act(session, { do: "set", id: "ctxtZ-ORDER", value: "4990" });
    expect(session.timing.idle).toBeGreaterThanOrEqual(100);
  });

  test("a second round trip the answer starts through the queue belongs to the step", async () => {
    await open();
    await page.evaluate(() => (window as unknown as { makeQueue: () => void }).makeQueue());
    expect(await act(session, { do: "key", key: 8 })).toBe("key F8");
    // Both were sent, and the second one answered, when the action returned.
    expect(await posted()).toEqual(["vkey/8", "action/rows"]);
    expect(await page.evaluate(() => (window as unknown as { oLS: { bLocked(): boolean } }).oLS.bLocked())).toBe(false);
    expect(session.timing.posts).toBe(2);
  });

  test("with the queue watched, a key that puts nothing in it is answered as soon as the page has handled it", async () => {
    await open();
    await page.evaluate(() => (window as unknown as { makeQueue: () => void }).makeQueue());
    const r = await timed(() => act(session, { do: "key", key: 2 }));
    expect(r.note).toStartWith("key F2\nNothing was sent to SAP");
    // No guess of how long a request may take to leave: the queue is empty.
    expect(session.timing.start).toBeLessThan(250);
    expect(r.ms).toBeLessThan(1500);
  });

  test("a request that leaves after the queue looked empty is not answered as 'nothing was sent'", async () => {
    await open();
    await page.evaluate(() => {
      (window as unknown as { makeQueue: () => void }).makeQueue();
      (window as unknown as { outsideQueue: boolean }).outsideQueue = true;
    });
    const note = await act(session, { do: "key", key: 0 });
    expect(note).toBe("key Enter");
    expect(await posted()).toEqual(["vkey/0"]);
    expect(session.started).toBe(true);
  });

  test("an event Lightspeed puts in the queue later (a scroll, 200 ms) is waited for too", async () => {
    await open();
    await page.evaluate(() => (window as unknown as { makeQueue: () => void }).makeQueue());
    const r = await timed(() => act(session, { do: "key", key: 7 }));
    expect(r.note).toBe("key F7");
    expect(await posted()).toEqual(["action/scroll"]);
  });

  test("where the queue cannot be watched, a request that leaves 300 ms after the key is still waited for", async () => {
    await open();
    await page.evaluate(() => {
      (window as unknown as { lateEnter: boolean }).lateEnter = true;
    });
    for (let i = 0; i < 3; i++) expect(await act(session, { do: "key", key: 0 })).toBe("key Enter");
    expect(await posted()).toEqual(["vkey/0", "vkey/0", "vkey/0"]);
  });

  test("a key that moves in the page is cheap and says that nothing went to SAP", async () => {
    await open();
    await page.locator("#F1").focus();
    const r = await timed(() => act(session, { do: "key", key: "Tab" }));
    expect(r.note).toBe("key Tab\n(A key that moves in the page: nothing was sent to SAP.)");
    expect(r.ms).toBeLessThan(900);
  });

  test("Cancel (12, Escape or F12 by name) on the main window is its Cancel button", async () => {
    await open();
    for (const key of [12, "Escape", "F12"]) {
      const note = await act(session, { do: "key", key });
      expect(note).toBe("key Escape (pressed wnd[0]/tbar[0]/btn[12])");
    }
    expect(await page.evaluate(() => (window as unknown as { posted: string[] }).posted)).toEqual(["vkey/12", "vkey/12", "vkey/12"]);
  });

  test("Escape with a menu or a list open closes that only; the next Escape is Cancel (NEW-3)", async () => {
    await open();
    await page.evaluate(() => {
      (document.getElementById("CTX") as HTMLElement).style.top = "100px";
    });
    expect(await act(session, { do: "key", key: 12 })).toBe("key Escape (closed the open menu; the screen under it is as it was, nothing was sent to SAP)");
    await page.evaluate(() => {
      (document.getElementById("LIST") as HTMLElement).style.display = "block";
    });
    expect(await act(session, { do: "key", key: "Escape" })).toBe("key Escape (closed the open list; the screen under it is as it was, nothing was sent to SAP)");
    // The window's Cancel button was not pressed, and both are closed.
    expect(await posted()).toEqual([]);
    expect(await page.evaluate(() => [(document.getElementById("CTX") as HTMLElement).style.top, (document.getElementById("LIST") as HTMLElement).style.display])).toEqual(["-9999px", "none"]);
    expect(await act(session, { do: "key", key: 12 })).toBe("key Escape (pressed wnd[0]/tbar[0]/btn[12])");
    expect(await posted()).toEqual(["vkey/12"]);
  });

  test("the first double-click on a popup's list row only moves the cursor: it is made again", async () => {
    await open();
    await page.evaluate(() => {
      (document.getElementById("P1") as HTMLElement).style.display = "block";
    });
    const note = await act(session, { do: "dblclick", id: "wnd[1]/usr/lbl[4,5]" });
    expect(note).toBe("double-clicked wnd[1]/usr/lbl[4,5] (twice: the first double-click only gave the list the cursor)");
    expect(await page.evaluate(() => (window as unknown as { posted: string[] }).posted)).toEqual(["action/dblclick"]);
  });

  test("a session that ends during a step is said at once, not after the timeout", async () => {
    await open();
    await page.evaluate(() => {
      (window as unknown as { endOnEnter: boolean }).endOnEnter = true;
    });
    const t0 = Date.now();
    const e = await act(session, { do: "key", key: 0 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ActionError);
    expect((e as Error).message).toStartWith('The SAP session in this tab has ended: the page says "Goodbye. You have been logged off."');
    expect(Date.now() - t0).toBeLessThan(4000);
    // The next action and a look say so too, at once.
    expect(((await act(session, { do: "key", key: 0 }).catch((x: unknown) => x)) as Error).message).toContain("has ended");
    expect(await webguiView(session, { compact: true })).toContain("NOTE The SAP session in this tab has ended");
  });

  test("a look while a step still runs says the screen is from before it; an action after it waited is not run", async () => {
    await open();
    await page.evaluate(() => {
      (window as unknown as { stuck: boolean }).stuck = true;
    });
    expect((await webguiView(session, { compact: true })).split("\n").at(-1)).toBe(STILL_WORKING);
    // The step ends 1.5 s later: the action that waited for it does nothing and says why.
    setTimeout(() => {
      void page.evaluate(() => {
        (window as unknown as { stuck: boolean }).stuck = false;
      });
    }, 1500);
    const e = await act(session, { do: "key", key: 0 }).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/^SAP was still working on the step before this one; it finished \d\.\d s later/);
    expect(await page.evaluate(() => (window as unknown as { posted: string[] }).posted)).toEqual([]);
    expect(await webguiView(session, { compact: true })).not.toContain(STILL_WORKING);
  });
});

describe("what an action that sends nothing says", () => {
  test("by kind of action", () => {
    expect(nothingSent({ do: "set", id: "x", value: "1" })).toBeUndefined();
    expect(nothingSent({ do: "combo", id: "x" })).toBeUndefined();
    expect(nothingSent({ do: "key", key: "ArrowDown" })).toContain("moves in the page");
    expect(nothingSent({ do: "key", key: "Shift+Tab" })).toContain("moves in the page");
    expect(nothingSent({ do: "key", key: 81 })).toContain("this key does nothing on this screen");
    expect(nothingSent({ do: "press", id: "btn[8]" })).toContain("Nothing was sent to SAP for this action");
    // A radio button or a checkbox posts nothing until the next step: that is said as the normal case, not as a failure.
    expect(nothingSent({ do: "select", id: "radPVBALL" })).toBe("(Set in the page: SAP gets it with the next Enter or key.)");
    expect(nothingSent({ do: "select", id: "wnd[0]/usr/radPVBALL" })).toContain("SAP gets it with the next Enter");
    expect(nothingSent({ do: "check", id: "chkFLAG", value: true })).toContain("SAP gets it with the next Enter");
    expect(nothingSent({ do: "select", id: "tabpT\\02" })).toContain("Nothing was sent to SAP for this action");
    // A table control row selected (MM02's "Select View(s)"): kept in the page too, sent with the next Enter.
    expect(nothingSent({ do: "select", id: "tblSAPLMGMMTC_VIEW", row: 12 })).toBe("(Set in the page: SAP gets it with the next Enter or key.)");
  });
  test("F12 by name is Cancel, sent as Escape like key 12", () => {
    expect([vkey("F12"), vkey("f12"), vkey(12)]).toEqual(["Escape", "Escape", "Escape"]);
  });
  test("the page after a logoff is an end; Web GUI and the logon page are not", () => {
    // extractEnded runs in the page; here it is checked on a stand-in document.
    const run = (html: string, title = "") => {
      const doc = new DOMParserStandIn(html, title);
      return doc.run(extractEnded);
    };
    expect(run("<p>Goodbye. You have been logged off.</p>")).toBe("Goodbye. You have been logged off.");
    expect(run("<p>Logged off</p><input id='ToolbarOkCode'>")).toBe("");
    expect(run("<p>Log off</p><input type='password'>")).toBe("");
    expect(run("<p>Order 4990</p>")).toBe("");
  });
});

/** Runs a page function against a tiny document stand-in (no browser): querySelector by the few selectors it uses. */
class DOMParserStandIn {
  constructor(
    private html: string,
    private title: string,
  ) {}
  run(f: () => string): string {
    const html = this.html;
    const text = html.replace(/<[^>]+>/g, " ");
    const doc = {
      title: this.title,
      body: { innerText: text },
      querySelector: (sel: string) => {
        if (sel.includes("ToolbarOkCode") && html.includes("ToolbarOkCode")) return {};
        if (sel.includes("password") && html.includes("password")) return {};
        if (sel.includes("wnd[") && html.includes("wnd[")) return {};
        return null;
      },
    };
    const g = globalThis as unknown as { document?: unknown };
    const before = g.document;
    g.document = doc;
    try {
      return f();
    } finally {
      g.document = before;
    }
  }
}

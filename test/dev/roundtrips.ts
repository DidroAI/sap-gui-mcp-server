/**
 * Development only: how many browser round trips (Playwright calls) and how
 * much fixed waiting each Web GUI step costs, on a synthetic page that
 * answers like Web GUI (one POST per step, `oLS.bLocked()` while it runs).
 * No SAP: the page is made up.
 *
 *   SAP_TEST_CHROME=/path/to/chrome bun test/dev/roundtrips.ts
 *
 * Each step is counted as the server runs it for sap_act: the guard
 * (`ended`, then `assess`), the action (`act`), then the answer (the
 * session facts, then the view). sap_look is the view alone. The session
 * check of the registry (tab still Web GUI's, its facts) comes on top of
 * every tool call and is not counted here.
 *
 * "calls" counts every message the Playwright client sends (an evaluate, a
 * locator count, a click, a wait); "evaluate" the evaluates among them;
 * "sleep" the waits sent to the browser (waitForTimeout) in milliseconds.
 * The polls and the settle waits of session.ts pause in the server without
 * a message, so they show in "wall", not in "sleep".
 */
import { chromium, type Page } from "playwright-core";
import type { Action } from "../../src/core/types.js";
import { extractFacts } from "../../src/webgui/page.js";
import { webguiView } from "../../src/webgui/index.js";
import { act, assess } from "../../src/webgui/reader.js";
import { WebGuiSession } from "../../src/webgui/session.js";

const exe = process.env.SAP_TEST_CHROME;
if (!exe) throw new Error("set SAP_TEST_CHROME to a Chrome or chrome-headless-shell");

const sid = (id: string, type: string, modal = 0) => `{ModalNo:${modal},SID:'${id}',Type:'${type}'}`;
const PAGE = `<!doctype html><html lang="en"><head><title>Synthetic</title></head><body>
<div id="cuaheader" lsdata="{1:'Synthetic\\x20screen'}">Synthetic screen</div>
<input id="ToolbarOkCode" lsdata="{0:'FREETEXT',20:${sid("wnd[0]/tbar[0]/okcd", "GuiOKCodeField")}}">
<div id="CANCEL" title="Cancel (F12)" onclick="post('vkey/12')" lsdata="{0:'Cancel',19:'F12',28:${sid("wnd[0]/tbar[0]/btn[12]", "GuiButton")}}">Cancel</div>
<div id="EXEC" title="Execute (F8)" onclick="post('vkey/8')" lsdata="{0:'Execute',19:'F8',28:${sid("wnd[0]/tbar[1]/btn[8]", "GuiButton")}}">Execute</div>
<label id="L1" lsdata="{1:'F1',3:'Order',19:${sid("wnd[0]/usr/lblZ-ORDER", "GuiLabel")}}">Order</label>
<input id="F1" value="" lsdata="{0:'x',20:${sid("wnd[0]/usr/ctxtZ-ORDER", "GuiCTextField")}}">
<div id="sysInfoAreaMenuItemSAPITS_MBAR_TRANSACTION" lsdata="{13:'ZT01'}"></div>
<div id="sysInfoAreaMenuItemSAPITS_MBAR_DYNPRO" lsdata="{13:'ZPROG/0100'}"></div>
<script>
  window.oLS = { n: 0, bLocked: function () { return this.n > 0; } };
  function post(what) {
    window.oLS.n++;
    fetch('/sap/bc/gui/sap/its/webgui/post', { method: 'POST', body: JSON.stringify([{ post: what + '/ses[0]' }]) })
      .then(function () { window.oLS.n--; });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') setTimeout(function () { post('vkey/0'); }, 40);
  });
</script>
</body></html>`;

interface Count {
  calls: number;
  evaluate: number;
  sleep: number;
}

const browser = await chromium.launch({ executablePath: exe, headless: true });
const page: Page = await (await browser.newContext()).newPage();
await page.route("**/*", async (r) => {
  if (r.request().method() === "POST") {
    await new Promise((x) => setTimeout(x, 100));
    return r.fulfill({ contentType: "text/plain", body: "ok" });
  }
  return r.fulfill({ contentType: "text/html", body: PAGE });
});
await page.goto("http://sap.test/sap/bc/gui/sap/its/webgui?sap-client=100");
const session = new WebGuiSession(page.mainFrame());

let count: Count = { calls: 0, evaluate: 0, sleep: 0 };
const connection = (page as unknown as { _connection: { sendMessageToServer: (...a: unknown[]) => unknown } })._connection;
const send = connection.sendMessageToServer.bind(connection);
connection.sendMessageToServer = (object: unknown, method: unknown, params: unknown, ...rest: unknown[]) => {
  count.calls++;
  if (typeof method === "string" && /^evaluate/.test(method)) count.evaluate++;
  if (method === "waitForTimeout") count.sleep += Number((params as { waitTimeout?: number; timeout?: number })?.waitTimeout ?? (params as { timeout?: number })?.timeout ?? 0);
  return send(object, method, params, ...rest);
};

async function measure<T>(f: () => Promise<T>): Promise<Count & { ms: number }> {
  count = { calls: 0, evaluate: 0, sleep: 0 };
  const t0 = Date.now();
  await f();
  return { ...count, ms: Date.now() - t0 };
}

const rows: string[] = [];
const line = (name: string, phase: string, c: Count & { ms: number }) =>
  rows.push(`${name.padEnd(14)} ${phase.padEnd(7)} calls ${String(c.calls).padStart(3)}  evaluate ${String(c.evaluate).padStart(3)}  sleep ${String(c.sleep).padStart(5)} ms  wall ${String(c.ms).padStart(5)} ms`);

line("look", "view", await measure(() => webguiView(session, { compact: true })));
const steps: [string, Action][] = [
  ["okcode", { do: "okcode", value: "/nZT02" }],
  ["set", { do: "set", id: "ctxtZ-ORDER", value: "4969" }],
  ["press", { do: "press", id: "btn[8]" }],
  ["key Enter", { do: "key", key: 0 }],
  ["key F2 (none)", { do: "key", key: 2 }],
];
for (const [name, action] of steps) {
  const judge = await measure(async () => {
    await session.ended();
    await assess(session, action);
  });
  const run = await measure(() => act(session, action));
  const answer = await measure(async () => {
    await page.mainFrame().evaluate(extractFacts);
    await webguiView(session, { compact: true });
  });
  line(name, "judge", judge);
  line(name, "act", run);
  line(name, "answer", answer);
  line(name, "total", { calls: judge.calls + run.calls + answer.calls, evaluate: judge.evaluate + run.evaluate + answer.evaluate, sleep: judge.sleep + run.sleep + answer.sleep, ms: judge.ms + run.ms + answer.ms });
}
console.log(rows.join("\n"));
await browser.close();

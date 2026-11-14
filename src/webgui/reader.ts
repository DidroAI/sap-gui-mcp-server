/**
 * The SAP screen reader for Web GUI, in the format of the SAP GUI for Windows
 * reader: one control per line, addressed by its SAP GUI scripting id, with
 * state; and the same JSON actions, run with Playwright.
 *
 *   look(session)          the full view (core/compact.ts makes the compact one)
 *   act(session, action)   one action
 *
 * Actions, on an id from the view (full id, short id, or a field's SAP name):
 *   {"do":"set","id":"ctxtVBAK-AUART","value":"OR"}
 *   {"do":"press","id":"wnd[0]/tbar[1]/btn[8]"}
 *   {"do":"key","key":0}                 sendVKey: 0 Enter, 2 F2, 3 Back, 4 F4, 8 F8, 12 Cancel...
 *   {"do":"f4","id":"ctxtVBAK-AUART"}    value help on a field
 *   {"do":"dblclick","id":"..."}         a list line or label (with node/row: tree/grid)
 *   {"do":"check","id":"chkVBAK-AUTLF","value":true}
 *   {"do":"select","id":"tabpT\\06"}     tab, radio button, menu entry (wnd[0]/mbar/menu[1]/menu[0])
 *   {"do":"combo","id":"cmbVBAK-LIFSK","key":"01"}
 *   {"do":"okcode","value":"/nVA03"}
 *   {"do":"tree","id":"shell","node":"7","how":"double|select|expand"}
 *   {"do":"grid","id":"shell","row":0,"col":"VBELN","how":"double|select"}
 *   {"do":"toolbar","id":"shell","button":"&FIND"}
 */
import type { Frame, Locator } from "playwright-core";
import { ActionError, type Action } from "../core/types.js";
import { extractLook, extractViewer, markControl, markRow, normalizeLsdata } from "./page.js";
import type { WebGuiSession } from "./session.js";

const MAX_GRID_ROWS = 50;
const MAX_TREE_NODES = 300;

/** Reads an HTML viewer and the frames inside it, numbering controls across them. */
async function readViewer(fr: Frame): Promise<{
  lines: string[];
  frames: { frame: Frame; from: number; to: number }[];
}> {
  const lines: string[] = [];
  const frames: { frame: Frame; from: number; to: number }[] = [];
  let n = 0;
  const walk = async (x: Frame) => {
    const r = await x
      .evaluate(extractViewer, n)
      .catch(() => ({ lines: [] as string[], next: n }));
    frames.push({ frame: x, from: n + 1, to: r.next });
    lines.push(...r.lines);
    n = r.next;
    for (const c of x.childFrames()) await walk(c);
  };
  await walk(fr);
  return { lines, frames };
}

/** Frames of HTML viewers inside the Web GUI frame, with the viewer's scripting id. */
async function viewerFrames(
  f: Frame,
): Promise<{ sid: string; frame: Frame }[]> {
  const ids: { sid: string; dom: string }[] = await f.evaluate(() =>
    Array.from(
      document.querySelectorAll("iframe[data-ls*=\"Type:'GuiHtmlViewer'\"]"),
    )
      .filter((e) => e.getBoundingClientRect().width > 0)
      .map((e) => ({
        sid:
          /SID:'((?:[^'\\]|\\.)*)'/.exec(
            e.getAttribute("data-ls") ?? "",
          )?.[1] ?? "",
        dom: e.id,
      })),
  );
  const res: { sid: string; frame: Frame }[] = [];
  for (const { sid, dom } of ids) {
    const handle = await f.$(`iframe[id="${dom}"]`);
    const fr = await handle?.contentFrame();
    if (fr) res.push({ sid, frame: fr });
  }
  return res;
}

/**
 * Web GUI of ECC writes `lsdata` as a JavaScript object literal; Web GUI of
 * S/4HANA 2025 writes strict JSON. normalizeLsdata copies every `lsdata` into
 * `data-ls` in the ECC form, so the reader reads one form. This returns the
 * frame with `data-ls` up to date.
 */
async function lsFrame(session: WebGuiSession): Promise<Frame> {
  await session.frame.evaluate(normalizeLsdata).catch(() => 0);
  return session.frame;
}

/** The full view: a header line, a WINDOW line per window, then one line per control. */
/**
 * Web GUI's own dialogs (session timeout, connection lost) are popup windows
 * of the page, not SAP windows: they carry no scripting id, so the SAP read
 * does not list them, yet they block the screen. Listed as WINDOW browser.
 * Runs in the page: no String.prototype.trim (Web GUI patches it).
 */
function extractClientPopups(): { id: string; title: string; text: string; buttons: string[] }[] {
  const out: { id: string; title: string; text: string; buttons: string[] }[] = [];
  const clean = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").replace(/^ | $/g, "");
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("div[ct='PW']"))) {
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || el.offsetWidth === 0) continue;
    // An SAP popup window holds controls with scripting ids; those are read by the SAP read.
    if (el.querySelector("[lsdata*='wnd[']")) continue;
    const title = clean(el.querySelector(".urPWTitleText")?.textContent);
    const body = el.querySelector<HTMLElement>(".urPWContent");
    const buttons = Array.from(el.querySelectorAll<HTMLElement>("[ct='B'],button,[role='button']"))
      .map((b) => clean(b.textContent))
      .filter((t) => t.length > 0);
    const text = clean(body?.innerText);
    out.push({ id: el.id, title, text, buttons });
  }
  return out;
}

/** Lines for Web GUI's own dialogs, with what the agent can do about them. */
async function clientPopupLines(f: Frame): Promise<string[]> {
  const pops = await f.evaluate(extractClientPopups).catch(() => []);
  const out: string[] = [];
  for (const p of pops) {
    out.push(`WINDOW browser  "${p.title}"  (a Web GUI message above the SAP screen; the SAP screen does not react until it is closed)`);
    if (p.text) out.push(`text  "${p.text}"`);
    for (const b of p.buttons) out.push(`button  ${b}`);
    if (/timeout|timed out|abgelaufen|expir/i.test(`${p.id} ${p.title} ${p.text}`))
      out.push("NOTE the SAP session has timed out. Ask the user to reload the page and log on again; this server never logs on.");
  }
  return out;
}

export async function look(session: WebGuiSession): Promise<string> {
  const f = await lsFrame(session);
  const r = await f.evaluate(extractLook, {
    grid: MAX_GRID_ROWS,
    tree: MAX_TREE_NODES,
  });
  const out = [
    `TRANSACTION ${r.transaction}  PROGRAM ${r.program}  SCREEN ${r.screen}${r.system ? `  SYSTEM ${r.system}` : ""}`,
  ];
  // Web GUI's own dialogs first: while one is open, nothing below reacts.
  out.push(...(await clientPopupLines(f)));
  const viewers = await viewerFrames(f).catch(() => []);
  for (const w of r.windows) {
    out.push(`WINDOW ${w.id}  "${w.title}"`);
    for (const l of w.lines) {
      out.push(l);
      if (l.endsWith("  html-viewer")) {
        const v = viewers.find((x) => l.startsWith(`${x.sid}  `));
        const inner = v ? (await readViewer(v.frame)).lines : [];
        for (const x of inner) out.push(`${v!.sid}/${x}`);
      }
    }
  }
  return out.join("\n");
}

/** SAP virtual keys (sendVKey) as keyboard keys in Web GUI. */
export function vkey(k: unknown): string {
  if (typeof k === "string" && !/^\d+$/.test(k)) return k;
  const n = Number(k);
  const f = (i: number) => `F${i}`;
  if (n === 0) return "Enter";
  if (n === 11) return "Control+s";
  if (n === 12) return "Escape";
  if (n >= 1 && n <= 10) return f(n);
  if (n >= 13 && n <= 24) return `Shift+${f(n - 12)}`;
  if (n >= 25 && n <= 36) return `Control+${f(n - 24)}`;
  if (n >= 37 && n <= 48) return `Control+Shift+${f(n - 36)}`;
  if (n === 70) return "Control+e";
  if (n === 71) return "Control+f";
  if (n === 80) return "Control+PageUp";
  if (n === 81) return "PageUp";
  if (n === 82) return "PageDown";
  if (n === 83) return "Control+PageDown";
  throw new ActionError(`unknown virtual key ${k}`);
}

async function locate(session: WebGuiSession, id: string) {
  const f = await lsFrame(session);
  const r = await f.evaluate(markControl, id);
  if (typeof r === "string") throw new ActionError(r);
  return { f, c: r, loc: f.locator("[data-sap-act]").first() };
}

async function typeInto(
  session: WebGuiSession,
  loc: Locator,
  value: string,
): Promise<void> {
  await session.closeSuggestions();
  await loc.focus({ timeout: 10000 });
  // Select all: Ctrl+A, or Cmd+A when the browser runs on macOS.
  await loc.press("ControlOrMeta+A");
  await loc.press("Delete");
  if (value) await loc.pressSequentially(value, { delay: 15 });
  await session.waitIdle();
  await session.closeSuggestions();
}

/** One action. Returns a one-line note of what was done; throws ActionError when it cannot. */
export async function act(session: WebGuiSession, a: Action): Promise<string> {
  try {
    return await run(session, a);
  } catch (e) {
    throw tidy(e);
  }
}

/** Playwright's errors carry a long call log: keep the first line, and say what blocks when a popup covers the control. */
function tidy(e: unknown): Error {
  if (e instanceof ActionError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const first = message.split("\n")[0] ?? message;
  if (message.includes("intercepts pointer events"))
    return new ActionError(`${first} Another window covers this control (a popup is open?): look at the screen and answer the popup first.`);
  return new ActionError(first);
}

async function run(session: WebGuiSession, a: Action): Promise<string> {
  const page = session.page;
  const id = String(a.id ?? "");
  switch (a.do) {
    case "okcode":
      await session.okCode(String(a.value ?? ""));
      return `okcode ${a.value}`;
    case "key": {
      const k = vkey(a.key ?? a.value);
      await session.pressKey(k);
      await session.waitRoundtrip();
      return `key ${k}`;
    }
    case "tree":
    case "grid": {
      const f = await lsFrame(session);
      const r = await f.evaluate(markRow, {
        sid: id,
        row: a.row,
        node: a.node,
        col: a.col,
      });
      if (r !== "ok") throw new ActionError(r);
      const how = a.how ?? "double";
      const cell = f.locator("[data-sap-act='cell']").first();
      await cell.scrollIntoViewIfNeeded().catch(() => {});
      if (how === "expand") {
        const exp = f.locator("[data-sap-act='expander']");
        if (await exp.count()) await exp.first().click();
        else await cell.click();
      } else if (how === "double") await cell.dblclick();
      else await cell.click();
      await session.waitRoundtrip(1200);
      return `${a.do} ${how} ${a.node ?? `row ${a.row}`}`;
    }
    case "select": {
      if (/\/mbar\/menu\[/.test(id) || /^menu\[/.test(id)) {
        // Menu path: open the Menu button, then each level by its scripting id.
        const f = await lsFrame(session);
        const full = id.startsWith("wnd[") ? id : `wnd[0]/mbar/${id}`;
        await f.locator("#cua2sapmenu_btn").click();
        await page.waitForTimeout(300);
        const parts = full.split("/").slice(2);
        for (let i = 1; i <= parts.length; i++) {
          const sid = `wnd[0]/mbar/${parts.slice(0, i).join("/")}`;
          const row = f
            .locator(`tr[id="${sid}"]`)
            .filter({ visible: true })
            .first();
          await row.click({ timeout: 10000 });
          await page.waitForTimeout(300);
        }
        await session.waitRoundtrip();
        return `menu ${full}`;
      }
      const { loc, c } = await locate(session, id);
      await loc.click();
      await session.waitRoundtrip(1200);
      return `selected ${c.sid}`;
    }
    case "toolbar": {
      const { loc, c } = await locate(session, `${id}/${a.button}`).catch(() =>
        locate(session, String(a.button)),
      );
      await loc.click();
      await session.waitRoundtrip(1200);
      return `pressed ${c.sid}`;
    }
    case "dblclick":
      if (a.node !== undefined)
        return run(session, { ...a, do: "tree", how: "double" });
      if (a.row !== undefined)
        return run(session, { ...a, do: "grid", how: "double" });
      break;
    default:
      break;
  }
  if (id.startsWith("html[") || /\/html\[\d+\]$/.test(id))
    return actHtml(session, a);
  const { loc, c } = await locate(session, id);
  switch (a.do) {
    case "set": {
      if (c.type === "GuiCheckBox") return run(session, { ...a, do: "check" });
      if (c.type === "GuiComboBox")
        return run(session, { ...a, do: "combo", key: a.value });
      if (c.readonly) throw new ActionError(`${c.sid} is read-only`);
      await typeInto(session, loc, String(a.value ?? ""));
      return `set ${c.sid}`;
    }
    case "press":
      await loc.click();
      await session.waitRoundtrip(1200);
      return `pressed ${c.sid}`;
    case "focus":
      await loc.focus();
      return `focus ${c.sid}`;
    case "dblclick":
      await loc.dblclick();
      await session.waitRoundtrip(1200);
      return `double-clicked ${c.sid}`;
    case "f4":
      await loc.focus();
      await page.keyboard.press("F4");
      await session.waitRoundtrip();
      return `value help on ${c.sid}`;
    case "check": {
      const on =
        a.value === undefined
          ? true
          : /^(x|true|1|on|yes)$/i.test(String(a.value));
      if (c.checked !== on) {
        await loc.click();
        await session.waitRoundtrip(800);
      }
      return `${c.sid} ${on ? "checked" : "unchecked"}`;
    }
    case "combo": {
      const want = String(a.key ?? a.value ?? "").toLowerCase();
      const f = await lsFrame(session);
      await loc.click();
      await page.waitForTimeout(400);
      const items = f
        .locator("[ct='LIB_I'],[role='option']")
        .filter({ visible: true });
      const n = await items.count();
      const texts: string[] = [];
      const keys: string[] = [];
      for (let i = 0; i < n; i++) {
        texts.push(
          ((await items.nth(i).innerText()) || "")
            .replace(/\s+/g, " ")
            .toLowerCase(),
        );
        keys.push(
          (
            (await items.nth(i).getAttribute("data-itemkey")) ?? ""
          ).toLowerCase(),
        );
      }
      let idx = keys.indexOf(want);
      if (idx < 0)
        idx = texts.findIndex((t) => t === want || t.startsWith(`${want} `));
      if (idx < 0) idx = texts.findIndex((t) => t.includes(want));
      if (idx < 0) {
        await page.keyboard.press("Escape");
        throw new ActionError(`no entry ${want} in ${c.sid}: ${texts.join(" | ")}`);
      }
      await items.nth(idx).click();
      await session.waitRoundtrip(800);
      return `${c.sid} = ${texts[idx]}`;
    }
    default:
      throw new ActionError(`unknown action ${a.do}`);
  }
}

/** Actions on controls of an HTML viewer (html[n] from the view). */
async function actHtml(session: WebGuiSession, a: Action): Promise<string> {
  const id = String(a.id);
  const n = /html\[(\d+)\]$/.exec(id)?.[1];
  const f = await lsFrame(session);
  const viewers = await viewerFrames(f);
  const v = viewers.find((x) => id.startsWith(`${x.sid}/`)) ?? viewers[0];
  if (!v || !n) throw new ActionError(`no HTML viewer control ${id}`);
  const { frames } = await readViewer(v.frame); // numbers the controls as the view did
  const hit = frames.find((x) => Number(n) >= x.from && Number(n) <= x.to);
  if (!hit) throw new ActionError(`no HTML viewer control ${id}`);
  const loc = hit.frame.locator(`[data-sap-html="${n}"]`);
  const tag = await loc.evaluate((e) => e.tagName);
  if (a.do === "combo" || (a.do === "set" && tag === "SELECT")) {
    const want = String(a.key ?? a.value ?? "");
    const r = await loc
      .selectOption(want)
      .catch(() => loc.selectOption({ label: want }));
    await session.waitRoundtrip(1500);
    return `selected ${r.join(",")} in ${id}`;
  }
  if (a.do === "set") await loc.fill(String(a.value ?? ""));
  else if (a.do === "dblclick") await loc.dblclick();
  else if (a.do === "check")
    await loc.setChecked(
      a.value === undefined
        ? true
        : /^(x|true|1|on|yes)$/i.test(String(a.value)),
    );
  else await loc.click();
  await session.waitRoundtrip(1200);
  return `${a.do} ${id}`;
}

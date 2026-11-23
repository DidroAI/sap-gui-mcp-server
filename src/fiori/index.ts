/**
 * The Fiori surface: Chrome tabs where SAPUI5 runs (a Fiori launchpad or a
 * stand-alone UI5 app), read through the UI5 control tree.
 *
 * Which tabs is decided in one place, browser/classify.ts: SAPUI5 runs in the
 * page (`sap.ui.getCore`), and the page is SAP's: a launchpad URL under /sap/
 * (`/sap/bc/ui2/flp`, the FioriLaunchpad.html shell) or `sap.ushell` in the
 * page. A tab whose own page is SAP GUI for HTML belongs to the Web GUI
 * surface; a Web GUI app inside a launchpad iframe is read here, in the same
 * view as the shell around it.
 *
 * Actions, on ids from the view (the compact view's `#tail`, or a full UI5 id):
 *
 *   {"do":"set","id":"…","value":"…"}      type into an input, then Tab ("enter": true ends with Enter; search fields always do)
 *   {"do":"press","id":"…"}                click a button, link, row or tile ("click" is the same); a grid-table row
 *                                          opens through its row action's navigation arrow when it has one
 *   {"do":"select","id":"…"}               tab, list item (its selection box where it has one), segmented button,
 *                                          radio button, grid-table row (its row selector), object-page section
 *                                          by its id, its tab's id or its title (the view's SECTIONS line), through
 *                                          the layout's API: also a tab that sits in the overflow
 *   {"do":"check","id":"…","value":true}   checkbox, switch, toggle button, selectable row; without value: toggle
 *   {"do":"combo","id":"…","key":"…"}      entry of sap.m.Select, ComboBox or MultiComboBox by key or text, through the
 *                                          control's API; other dropdowns in two steps (open, pick the option).
 *                                          An unknown entry, or no key at all, answers with the list of entries
 *                                          and chooses nothing.
 *   {"do":"key","key":"Enter"}             Enter, Space, Escape, Tab, Shift+Tab, F4, Delete, Backspace, arrows,
 *                                          PageUp/PageDown, Home, End, Back, Control+S, Control+Enter; SAP GUI's
 *                                          numbers 0, 3, 4, 11, 12 mean the same. Back is the launchpad's back
 *                                          button; it never leaves the launchpad for another site.
 *
 * Extra actions, beyond the shared vocabulary:
 *
 *   {"do":"dblclick","id":"…"}             double-click a control ("double" in the original reader)
 *   {"do":"f4","id":"…"}                   open a field's value help (its value-help icon, else F4 in the field)
 *   {"do":"scroll","how":"down"}           down, up, top or bottom in the open popup or the page's main area; with an
 *                                          id, in the scroll area around that control ("how":"to" brings it into view).
 *                                          The view holds what the viewport shows and says when there is more.
 *   {"do":"open","app":"#SalesOrder-manage"}  open a launchpad app by its intent (with parameters: "#SalesOrder-display?SalesOrder=4711").
 *                                          The launchpad's hash is set, as a bookmark does: the tab, its origin and the
 *                                          logon stay. Never a URL. Rated as navigation; SAP_ALLOW_TCODES and
 *                                          SAP_BLOCK_TCODES apply to the intent before it is opened.
 *   "fill" and "double"                    the original reader's names for set and dblclick, still accepted
 *
 * okcode, tree, grid and toolbar exist only on SAP GUI screens: they go to the
 * Web GUI frame when the launchpad shows one.
 *
 * Environment: SAP_FIORI_WAIT=busy turns RecordReplay.waitForUI5 off (the
 * driver then reads UI5's busy state only, and loads nothing into the page).
 */
import { chromeAttached, chromeDoctor, chromeTabs, noSessionHint, sapTabs, stillOwned } from "../browser/chrome.js";
import { classify, tabSigns, tabWhere } from "../browser/classify.js";
import type { DiscoverOptions, Driver, SessionInfo, Surface } from "../core/types.js";
import { FioriDriver, pageInfo, sessionOf } from "./driver.js";
import { isPendingUrl, PendingTab, pendingSession, readPending } from "./pending.js";

export { isLaunchpadUrl, isWebguiUrl } from "../browser/classify.js";
export { FioriDriver, sessionOf, WEBGUI_MARK } from "./driver.js";
export { assessAction, assessControl, RULES } from "./risk.js";

type Env = Record<string, string | undefined>;

/** The session line of a tab, with where it lives named by its title (Chrome gives no tab position). */
function named(session: SessionInfo): SessionInfo {
  session.where = tabWhere(session.title, session.url);
  return session;
}

/** The Fiori tabs among the open tabs (the classifier's answer), with what each page says about itself. */
async function fioriTabs(env: Env, options: DiscoverOptions = {}) {
  const mine = (await sapTabs(env, options)).filter((t) => t.owner === "fiori");
  return Promise.all(
    mine.map(async ({ tab }) => {
      const info = await pageInfo(tab.page);
      return { tab, info, session: named(sessionOf(tab, 0, info)) };
    }),
  );
}

/**
 * Tabs at a launchpad address that show no launchpad (a logon or password page, a page that did not load,
 * a tab that does not answer): listed, so that the agent can say what the user has to do (see pending.ts).
 */
async function pendingTabs(env: Env, options: DiscoverOptions = {}) {
  const tabs = (await chromeTabs(env, options)).filter((t) => isPendingUrl(t.url));
  const found = await Promise.all(
    tabs.map(async (tab) => {
      if (classify(tab.page.url(), await tabSigns(tab.page)) !== null) return undefined;
      return { tab, session: named(pendingSession(tab, await readPending(tab))) };
    }),
  );
  return found.filter((t) => t !== undefined);
}

export function fioriSurface(env: Env): Surface {
  const options = { recordReplay: (env.SAP_FIORI_WAIT ?? "").toLowerCase() !== "busy", idleTimeoutMs: 30_000 };
  return {
    name: "fiori",
    discover: async (options): Promise<SessionInfo[]> => {
      const [live, pending] = await Promise.all([fioriTabs(env, options), pendingTabs(env, options)]);
      // A tab whose launchpad came up between the two readings is the launchpad's.
      return [...live.map((x) => x.session), ...pending.filter((p) => !live.some((x) => x.session.id === p.session.id)).map((p) => p.session)];
    },
    open: async (session): Promise<Driver> => {
      const hit = (await fioriTabs(env)).find((x) => x.session.id === session.id);
      if (!hit) {
        const waiting = (await pendingTabs(env)).find((x) => x.session.id === session.id);
        if (waiting) return new PendingTab(waiting.tab, waiting.session);
      }
      if (!hit) throw new Error(`The Fiori tab of session ${session.id} is no longer open.`);
      const driver = new FioriDriver(hit.tab, hit.session, 0, options);
      // The driver's own refresh names the tab by a number: name it by its title, as discovery does.
      const refresh = driver.refresh.bind(driver);
      return Object.assign(driver, {
        refresh: async () => named(await refresh()),
        /** The tab is open, its browser connected, and it is still Fiori's (not a Web GUI page of its own now). */
        valid: () => stillOwned(hit.tab.page, "fiori", env),
      });
    },
    doctor: async () => {
      const out = await chromeDoctor(env);
      // No browser connected (the SAP window is not open yet): nothing to read, and doctor opens nothing.
      if (out.some((c) => !c.ok) || !chromeAttached()) return out;
      try {
        const tabs = await fioriTabs(env);
        out.push({
          ok: true,
          check: "Fiori tabs",
          detail: tabs.length
            ? tabs.map((t) => `${t.session.where}: UI5 ${t.info.version ?? "not loaded"}${t.info.launchpad ? ", launchpad" : ""}, system ${t.session.system ?? "?"}/${t.session.client ?? "?"}, user ${t.session.user ?? "?"}`).join("; ")
            : "no Fiori tab now (open the Fiori launchpad or a Fiori app in Chrome)",
        });
      } catch (e) {
        out.push({ ok: false, check: "Fiori tabs", detail: (e as Error).message });
      }
      return out;
    },
    whenEmpty: () => noSessionHint(env),
  };
}

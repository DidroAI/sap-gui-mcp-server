/**
 * The Fiori surface: Chrome tabs where SAPUI5 runs (a Fiori launchpad or a
 * stand-alone UI5 app), read through the UI5 control tree.
 *
 * Which tabs: `sap.ui.getCore` exists in the page, or the URL is a launchpad
 * (`/sap/bc/ui2/flp`, `/ui#`, `cp.portal`, `launchpad`). A tab whose own page
 * is SAP GUI for HTML belongs to the Web GUI surface; a Web GUI app inside a
 * launchpad iframe is read here, in the same view as the shell around it.
 *
 * Actions, on ids from the view (the compact view's `#tail`, or a full UI5 id):
 *
 *   {"do":"set","id":"…","value":"…"}      type into an input, then Tab ("enter": true ends with Enter; search fields always do)
 *   {"do":"press","id":"…"}                click a button, link, row or tile ("click" is the same)
 *   {"do":"select","id":"…"}               tab, list item (its selection box where it has one), segmented button,
 *                                          radio button, object-page section, grid-table row (its row selector)
 *   {"do":"check","id":"…","value":true}   checkbox, switch, toggle button, selectable row; without value: toggle
 *   {"do":"combo","id":"…","key":"…"}      entry of sap.m.Select, ComboBox or MultiComboBox by key or text, through the
 *                                          control's API; other dropdowns in two steps (open, pick the option).
 *                                          An unknown entry answers with the list of entries.
 *   {"do":"key","key":"Enter"}             Enter, Escape, Tab, Shift+Tab, F4, arrows, PageUp/PageDown, Home, End, Back,
 *                                          Control+S, Control+Enter; SAP GUI's numbers 0, 3, 4, 11, 12 mean the same
 *
 * Extra actions, beyond the shared vocabulary:
 *
 *   {"do":"dblclick","id":"…"}             double-click a control ("double" in the original reader)
 *   {"do":"f4","id":"…"}                   open a field's value help (its value-help icon, else F4 in the field)
 *   {"do":"scroll","how":"down"}           down, up, top or bottom in the open popup or the page's main area; with an
 *                                          id, in the scroll area around that control ("how":"to" brings it into view).
 *                                          The view holds what the viewport shows and says when there is more.
 *   "fill" and "double"                    the original reader's names for set and dblclick, still accepted
 *
 * okcode, tree, grid and toolbar exist only on SAP GUI screens: they go to the
 * Web GUI frame when the launchpad shows one.
 *
 * Environment: SAP_FIORI_WAIT=busy turns RecordReplay.waitForUI5 off (the
 * driver then reads UI5's busy state only, and loads nothing into the page).
 */
import { chromeDoctor, chromeTabs } from "../browser/chrome.js";
import type { SessionInfo, Surface } from "../core/types.js";
import { FioriDriver, isLaunchpadUrl, isWebguiUrl, pageInfo, sessionOf } from "./driver.js";

export { FioriDriver, isLaunchpadUrl, isWebguiUrl, sessionOf, WEBGUI_MARK } from "./driver.js";
export { assessAction, assessControl, RULES } from "./risk.js";

type Env = Record<string, string | undefined>;

async function fioriTabs(env: Env) {
  const tabs = await chromeTabs(env);
  const found = await Promise.all(
    tabs.map(async (tab, i) => {
      // A tab whose own page is Web GUI is the Web GUI surface's.
      if (isWebguiUrl(tab.url)) return undefined;
      const info = await pageInfo(tab.page);
      if (!info.ui5 && !isLaunchpadUrl(tab.url)) return undefined;
      return { tab, n: i + 1, info, session: sessionOf(tab, i + 1, info) };
    }),
  );
  return found.filter((x) => x !== undefined);
}

export function fioriSurface(env: Env): Surface {
  const options = { recordReplay: (env.SAP_FIORI_WAIT ?? "").toLowerCase() !== "busy", idleTimeoutMs: 30_000 };
  return {
    name: "fiori",
    discover: async (): Promise<SessionInfo[]> => (await fioriTabs(env)).map((x) => x.session),
    open: async (session) => {
      const hit = (await fioriTabs(env)).find((x) => x.session.id === session.id);
      if (!hit) throw new Error(`The Fiori tab of session ${session.id} is no longer open.`);
      return new FioriDriver(hit.tab, hit.session, hit.n, options);
    },
    doctor: async () => {
      const out = await chromeDoctor(env);
      if (out.some((c) => !c.ok)) return out;
      try {
        const tabs = await fioriTabs(env);
        out.push({
          ok: true,
          check: "Fiori tabs",
          detail: tabs.length
            ? tabs.map((t) => `tab ${t.n}: UI5 ${t.info.version ?? "not loaded"}${t.info.launchpad ? ", launchpad" : ""}, system ${t.session.system ?? "?"}/${t.session.client ?? "?"}, user ${t.session.user ?? "?"}`).join("; ")
            : "no tab runs SAPUI5 now (open the Fiori launchpad or a Fiori app in Chrome)",
        });
      } catch (e) {
        out.push({ ok: false, check: "Fiori tabs", detail: (e as Error).message });
      }
      return out;
    },
  };
}

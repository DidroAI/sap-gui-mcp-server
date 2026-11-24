/**
 * Which surface owns a browser tab: Web GUI, Fiori, or none. One answer per
 * tab, used by both surfaces, so a tab is never listed twice and never by
 * the wrong one.
 *
 * - Web GUI wins: the main frame holds Web GUI's own content, or the URL
 *   path contains /sap/bc/gui/sap/its/webgui (any case).
 * - Fiori needs SAPUI5 in the main frame, plus a sign that it is SAP's: a
 *   launchpad URL under /sap/, or `sap.ushell` in the page (the launchpad's
 *   shell, also on SAP BTP where the URL says nothing). A page that merely
 *   runs UI5, or whose address merely contains "launchpad", is nobody's.
 * - Everything else is not ours: the server evaluates nothing more in it.
 *
 * Also here: SAP_ALLOW_ORIGINS, the list of origins the server may look at.
 */
import type { Page } from "playwright-core";
import { within } from "./tab.js";

export type TabOwner = "webgui" | "fiori" | null;

export const WEBGUI_PATH = "/sap/bc/gui/sap/its/webgui";

/** The launchpad's two addresses on an ABAP system. Matched on the path only, from its start. */
const LAUNCHPAD_PATH = /^\/sap\/bc\/(ui2\/flp(\/|$)|ui5_ui5\/ui2\/ushell\/shells\/abap\/fiorilaunchpad\.html$)/;

function pathOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.pathname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Is this the address of a Web GUI page (http or https, the Web GUI path, any case)? */
export const isWebguiUrl = (url: string): boolean => pathOf(url)?.includes(WEBGUI_PATH) === true;
/** Is this the address of a Fiori launchpad on an ABAP system? */
export const isLaunchpadUrl = (url: string): boolean => LAUNCHPAD_PATH.test(pathOf(url) ?? "");

/** What the main frame of a tab says about itself. */
export interface TabSigns {
  /** Web GUI's controls (`lsdata`) with its system information items or its command field. */
  webgui: boolean;
  /** SAPUI5 runs (`sap.ui.getCore`). */
  ui5: boolean;
  /** The launchpad's shell is loaded (`sap.ushell`). */
  ushell: boolean;
}

export const NO_SIGNS: TabSigns = { webgui: false, ui5: false, ushell: false };

/** The owner of a tab, from its URL and what its main frame says. Pure. */
export function classify(url: string, signs: TabSigns): TabOwner {
  if (pathOf(url) === undefined) return null;
  if (signs.webgui || isWebguiUrl(url)) return "webgui";
  if (signs.ui5 && (signs.ushell || isLaunchpadUrl(url))) return "fiori";
  return null;
}

/** Runs in the page. Reads three facts, changes nothing. */
export function readSigns(): { webgui: boolean; ui5: boolean; ushell: boolean } {
  const sap = (window as unknown as { sap?: { ui?: { getCore?: unknown }; ushell?: unknown } }).sap;
  return {
    webgui: !!document.querySelector("[lsdata]") && (!!document.querySelector("[id^='sysInfoAreaMenuItemSAPITS_']") || !!document.getElementById("ToolbarOkCode")),
    ui5: typeof sap?.ui?.getCore === "function",
    ushell: !!sap?.ushell,
  };
}

/** A tab Chrome has frozen or discarded never answers: discovery must not wait for it. */
const SIGNS_TIMEOUT_MS = 3000;

/** The signs of a tab's main frame; all false when the page does not answer in time. */
export function tabSigns(page: Pick<Page, "mainFrame">, timeoutMs = SIGNS_TIMEOUT_MS): Promise<TabSigns> {
  return within(
    Promise.resolve().then(() => page.mainFrame().evaluate(readSigns)),
    timeoutMs,
    NO_SIGNS,
  );
}

/** The origins of SAP_ALLOW_ORIGINS ("https://myhost:44300, https://other"), or undefined when none is set. */
export function allowedOrigins(env: Record<string, string | undefined>): string[] | undefined {
  const raw = (env.SAP_ALLOW_ORIGINS ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!raw.length) return undefined;
  return raw.map((entry) => {
    let u: URL | undefined;
    try {
      u = new URL(entry);
    } catch {
      /* reported below */
    }
    if (!u || !/^https?:$/.test(u.protocol)) throw new Error(`SAP_ALLOW_ORIGINS takes origins such as https://myhost:44300 (got "${entry}")`);
    return u.origin;
  });
}

/** The origin of a URL ("https://myhost:44300"), or undefined for anything but http and https. */
export function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** May the server look at a page of this URL? http and https only; with a list, only its origins. */
export function originAllowed(url: string, allowed: string[] | undefined): boolean {
  const origin = originOf(url);
  if (!origin) return false;
  return !allowed || allowed.includes(origin);
}

/**
 * Where a tab lives, for session lists. Chrome's DevTools protocol does not
 * give a tab's position in its window, so a number would not match what the
 * user sees: the title names the tab instead.
 */
export function tabWhere(title: string | undefined, url?: string): string {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  if (t) return `Chrome tab '${t.length > 60 ? `${t.slice(0, 57)}...` : t}'`;
  const origin = url ? originOf(url) : undefined;
  return origin ? `Chrome tab at ${origin}` : "Chrome tab";
}

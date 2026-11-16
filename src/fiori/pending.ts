/**
 * A Chrome tab at a launchpad address that shows no launchpad: SAP's logon
 * page, its "Change Password" page, an error page, a page that is still
 * loading, or a tab that does not answer at all. Before, such a tab was
 * nobody's and the agent was told "No SAP session found"; now it is listed,
 * and a look says what the tab shows and that the user has to finish it.
 *
 * The server does nothing in such a tab: every action is refused. When the
 * launchpad comes up, the tab is the Fiori driver's (same session id).
 */
import { classify, isLaunchpadUrl, tabSigns } from "../browser/classify.js";
import type { ChromeTab } from "../browser/chrome.js";
import { type Action, ActionError, type Assessment, type Driver, type SessionInfo } from "../core/types.js";

export type PendingKind = "password" | "other" | "silent";

export interface PendingFacts {
  kind: PendingKind;
  title: string;
  /** The first lines a person reads on the page; never the value of an input. */
  text: string;
}

/** Runs in the page: its title, whether it asks for a password, and its first lines of text. */
export function pendingFacts(): { title: string; password: boolean; text: string } {
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const lines = String(document.body?.innerText ?? "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return { title: document.title, password: Array.from(document.querySelectorAll("input[type='password']")).some(shown), text: lines.slice(0, 8).join(" | ").slice(0, 400) };
}

const ANSWER_MS = 2500;

/** What a tab that is not a launchpad shows; "silent" when the page does not answer in time. */
export async function readPending(tab: Pick<ChromeTab, "page" | "title">): Promise<PendingFacts> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ANSWER_MS);
  });
  const asked = Promise.resolve()
    .then(() => tab.page.mainFrame().evaluate(pendingFacts))
    .catch(() => undefined);
  const f = await Promise.race([asked, late]).finally(() => clearTimeout(timer));
  if (!f) return { kind: "silent", title: tab.title, text: "" };
  return { kind: f.password ? "password" : "other", title: f.title || tab.title, text: f.text };
}

const WHAT: Record<PendingKind, string> = {
  password: "it asks for a password (SAP's logon page, or its page to change the password)",
  other: "the launchpad has not come up (the page is still loading, or SAP shows a message or an error instead)",
  silent: "the tab does not answer (it is frozen or still working, or a browser dialog is open in it)",
};
const TODO: Record<PendingKind, string> = {
  password: "This server never logs on and never types a password: ask the user to finish this page in the browser, then look again.",
  other: "Look again in a moment; if it stays like this, ask the user to look at the tab.",
  silent: "Wait and look again; if it stays like this, ask the user to look at the tab (reloading it loses unsaved input).",
};

/** The session line of such a tab: its title says what it is, so sap_sessions already tells. */
export function pendingSession(tab: Pick<ChromeTab, "id" | "url" | "title">, facts: PendingFacts): SessionInfo {
  const s: SessionInfo = { id: `chrome:${tab.id}`, surface: "fiori", where: "Chrome tab", title: `${facts.title || "(no title)"} [no launchpad in this tab: ${facts.kind === "password" ? "logon or password page" : facts.kind === "silent" ? "the tab does not answer" : "not loaded"}]` };
  try {
    const u = new URL(tab.url);
    s.url = `${u.origin}${u.pathname}`;
    const client = u.searchParams.get("sap-client");
    if (client) s.client = client;
  } catch {
    /* not a URL we can parse */
  }
  return s;
}

/** Is this tab one of these: at a launchpad address, and not a launchpad or a Web GUI page? */
export const isPendingUrl = (url: string): boolean => isLaunchpadUrl(url);

export class PendingTab implements Driver {
  info: SessionInfo;
  constructor(
    private tab: ChromeTab,
    info: SessionInfo,
  ) {
    this.info = info;
  }
  private facts(): Promise<PendingFacts> {
    return readPending(this.tab);
  }
  async refresh(): Promise<SessionInfo> {
    this.info = { ...pendingSession({ id: this.tab.id, url: this.tab.page.url(), title: this.tab.title }, await this.facts()), where: this.info.where };
    return this.info;
  }
  /** Still at a launchpad address, and still nobody's: once the launchpad runs, the Fiori driver takes the tab. */
  async valid(): Promise<boolean> {
    try {
      if (this.tab.page.isClosed()) return false;
      const url = this.tab.page.url();
      return isPendingUrl(url) && classify(url, await tabSigns(this.tab.page)) === null;
    } catch {
      return false;
    }
  }
  async look(): Promise<string> {
    const f = await this.facts();
    return [
      ["FIORI", "(no launchpad in this tab)", this.info.client ? `client ${this.info.client}` : ""].filter(Boolean).join("  "),
      `PAGE ${f.title || "(no title)"}`,
      `[This tab is at a launchpad address, but ${WHAT[f.kind]}. ${TODO[f.kind]}]`,
      ...(f.text ? [`TEXT ${f.text}`] : []),
    ].join("\n");
  }
  private async refuse(): Promise<never> {
    const f = await this.facts();
    throw new ActionError(`Nothing was done: this tab ("${f.title || "no title"}") shows no launchpad, ${WHAT[f.kind]}. ${TODO[f.kind]}`);
  }
  assess(_action: Action): Promise<Assessment> {
    return this.refuse();
  }
  act(_action: Action): Promise<string> {
    return this.refuse();
  }
  async screenshot(): Promise<Buffer> {
    return this.tab.page.screenshot({ type: "png", timeout: 8000 });
  }
  async close(): Promise<void> {}
}

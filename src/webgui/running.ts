/**
 * A step that is still running after the action that started it gave up
 * waiting (its "timeout", or the default wait).
 *
 * Web GUI has no way to cancel a running step: on the release this was
 * checked on (ECC, kernel 7.53) its scripts hold no cancel function, its
 * menus have no "Cancel transaction", and the page is locked under the
 * loading sign until SAP answers. So the server cannot offer a cancel
 * either. What it can do is say so, and answer at once: an action sent
 * while that step runs is refused without waiting, with how long the step
 * has been running and the two ways out (wait, or have the session ended).
 */
import type { Page } from "playwright-core";
import type { WebGuiSession } from "./session.js";

interface Running {
  since: number;
  what: string;
}
const running = new WeakMap<Page, Running>();

/** The start of the error an action answers with when SAP outlasts its wait (session.ts `waitIdle`). */
export const GAVE_UP = "SAP was still working after";

export const NO_CANCEL = "Web GUI cannot cancel a running step.";

/** Remembers the step an action gave up on: `what` is the action as text, `since` when it was sent. */
export function gaveUpOn(session: WebGuiSession, what: string, since: number): void {
  running.set(session.page, { since, what });
}

const seconds = (r: Running, now: number) => Math.max(1, Math.round((now - r.since) / 1000));

/**
 * Why an action is refused because the step given up on is still running, or
 * undefined when none is (then it is forgotten). `locked` is Web GUI's lock
 * now; unknown counts as not running, and the action's own wait decides.
 */
export function stillRunning(session: WebGuiSession, locked: boolean | undefined, now = Date.now()): string | undefined {
  const r = running.get(session.page);
  if (!r) return undefined;
  if (locked !== true) {
    running.delete(session.page);
    return undefined;
  }
  return `SAP is still working on the step sent ${seconds(r, now)} s ago (${r.what}), so nothing was done. ${NO_CANCEL} Look again in a moment (sap_look): the screen of that step comes when it ends. To give the step up, the SAP session has to be ended (logged off and on again by whoever logs this session on); unsaved input is then lost.`;
}

/** For a view read while that step runs: how long it has been running, and which step it is. "" when none is known. */
export function runningSince(session: WebGuiSession, now = Date.now()): string {
  const r = running.get(session.page);
  return r ? ` The step (${r.what}) was sent ${seconds(r, now)} s ago. ${NO_CANCEL}` : "";
}

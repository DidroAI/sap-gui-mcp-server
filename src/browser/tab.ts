/**
 * Small things every surface does with a browser tab: wait for an answer no
 * longer than a set time, keep the tab focused while the server drives it,
 * and take its picture.
 */
import type { Page } from "playwright-core";

/**
 * The answer of `p`, or `otherwise` when it fails or takes longer than `ms`.
 * The timer is cleared when `p` answers first. A tab Chrome has frozen or
 * discarded never answers: this is how the server stops waiting for one.
 */
export function within<T>(p: Promise<T>, ms: number, otherwise: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(otherwise), ms);
  });
  return Promise.race([p.catch(() => otherwise), late]).finally(() => clearTimeout(timer));
}

/** Pages whose focus emulation was asked for, and how that went. */
const focused = new WeakMap<Page, Promise<boolean>>();

/**
 * Makes a tab behave as the visible, focused one while the server drives it.
 *
 * Chrome gives a tab in the background no animation frames and slows its
 * timers, and hands key presses only to a page that has focus. Playwright's
 * defaults turn focus emulation on, but `noDefaults` (which keeps the user's
 * viewport and settings as they are) leaves it off: Enter on a popup in a
 * background tab went nowhere while clicks worked, and Web GUI's own timers
 * stalled. Chrome's focus emulation (DevTools: "Emulate a focused page")
 * lifts this for the tab, without bringing it to the front: the user sees
 * nothing change. It lasts as long as the CDP session, so until the server
 * disconnects.
 *
 * One CDP session per page: calls that come together share the first one's
 * answer. A page that refused (it was closing, or the browser said no) is
 * asked again on the next call. True when focus emulation is on.
 */
export function keepFocused(page: Page): Promise<boolean> {
  const known = focused.get(page);
  if (known) return known;
  const asked = (async () => {
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      return true;
    } catch {
      // The server works as before, in a tab that is in front.
      return false;
    }
  })();
  focused.set(page, asked);
  void asked.then((ok) => {
    if (!ok && focused.get(page) === asked) focused.delete(page);
  });
  return asked;
}

/** A PNG of the tab. Chrome does not paint a tab in the background: then it is brought to the front and taken once more. */
export async function screenshotTab(page: Page): Promise<Buffer> {
  const shot = () => page.screenshot({ type: "png", timeout: 8000 });
  try {
    return await shot();
  } catch {
    await page.bringToFront();
    return shot();
  }
}

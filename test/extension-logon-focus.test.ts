/**
 * Log on from the side panel: the panel keeps the window's focus, so the logon page never has it
 * (document.hasFocus() is false) and the extension refused to type ("The logon page looks different
 * from SAP's"). The logon turns on focus emulation in its own tab before it types.
 *
 * The real-Chrome tests cannot show this: Playwright turns focus emulation on in every page it sees.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const bg = readFileSync(resolve(import.meta.dir, "../extension/background.js"), "utf8");
const start = bg.indexOf("async function doLogonSteps(");
/** The logon itself (doLogonSteps), up to the next top-level function. */
const logon = bg.slice(start, bg.slice(start + 1).search(/\n(async )?function /) + start + 1);

test("the logon tab gets focus emulation after attaching, before anything is typed", () => {
  const attach = logon.indexOf('chrome.debugger.attach({ tabId }, "1.3")');
  const emulate = logon.indexOf('"Emulation.setFocusEmulationEnabled", { enabled: true }');
  const typed = logon.indexOf("typeInto(");
  expect(attach).toBeGreaterThan(0);
  expect(emulate).toBeGreaterThan(attach);
  expect(typed).toBeGreaterThan(emulate);
});

test("typing still needs the field focused in the system's own top page", () => {
  const focus = bg.slice(bg.indexOf("const FOCUS ="), bg.indexOf("})()`;", bg.indexOf("const FOCUS =")));
  expect(focus).toContain("window.top !== window");
  expect(focus).toContain("document.activeElement === e && document.hasFocus()");
});

/**
 * Development only: logs a Chrome you started for testing on to a Fiori
 * launchpad, so the server has a session to find. The server itself never
 * logs on.
 *
 *   SAP_CHROME_CDP=http://127.0.0.1:9342 \
 *   FIORI_URL='https://localhost:44300/sap/bc/ui2/flp?sap-client=100&sap-language=EN' \
 *   SAP_USER=<user> SAP_PASSWORD_FILE=<file holding the password> \
 *   bun test/dev/fiori-logon.ts ['#SalesOrder-manage']
 *
 * The password is read from the file and typed into the logon page; it is
 * never printed. Uses the first launchpad tab of the browser, or opens one.
 * With a hash as argument, the tab then opens that app.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { chromium } from "playwright-core";

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
const cdp = need("SAP_CHROME_CDP");
const url = need("FIORI_URL");
const hash = process.argv[2] ?? "";

const browser = await chromium.connectOverCDP(cdp, { noDefaults: true });
try {
  const context = browser.contexts()[0];
  if (!context) throw new Error("the browser has no context");
  const base = url.split("#")[0] ?? url;
  const page = context.pages().find((p) => p.url().startsWith(base.split("?")[0] ?? base)) ?? (await context.newPage());
  if (!page.url().startsWith(base.split("?")[0] ?? base)) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
  const shell = () => page.evaluate(() => !!(window as unknown as { sap?: { ushell?: { Container?: unknown } } }).sap?.ushell?.Container).catch(() => false);
  const userField = page.locator("#USERNAME_FIELD-inner, input[name=sap-user]").first();
  const form = await userField.waitFor({ state: "visible", timeout: 15_000 }).then(
    () => true,
    () => false,
  );
  if (form) {
    const user = need("SAP_USER");
    const password = (await readFile(need("SAP_PASSWORD_FILE").replace(/^~/, homedir()), "utf8")).split(/\r?\n/)[0] ?? "";
    if (!password) throw new Error("the password file is empty");
    await userField.fill(user);
    await page.locator("#PASSWORD_FIELD-inner, input[name=sap-password]").first().fill(password);
    await page.locator("#LOGIN_LINK, #LOGON_BUTTON, button[type=submit]").first().click();
  }
  const until = Date.now() + 120_000;
  while (!(await shell())) {
    if (Date.now() > until) throw new Error("no launchpad 120 s after logon; look at the tab");
    await page.waitForTimeout(500);
  }
  if (hash) {
    await page.goto("about:blank");
    await page.goto(`${base}${hash}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  }
  console.log(`${form ? "logged on" : "already logged on"}: ${page.url().replace(/sap-user=[^&]*/g, "")}`);
} finally {
  // Disconnects; the browser and its tabs stay.
  await browser.close();
}

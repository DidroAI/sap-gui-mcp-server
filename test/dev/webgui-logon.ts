/**
 * Development only: logs a Chrome you started for testing on to SAP Web GUI,
 * so the server has a session to find. The server itself never logs on.
 *
 *   SAP_CHROME_CDP=http://127.0.0.1:9341 \
 *   WEBGUI_URL='http://localhost:8010/sap/bc/gui/sap/its/webgui?sap-client=800' \
 *   SAP_USER=<user> SAP_PASSWORD_FILE=<file holding the password> \
 *   bun test/dev/webgui-logon.ts
 *
 * The password is read from the file and typed into the logon page; it is
 * never printed. Opens a new tab unless a Web GUI tab is already logged on.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { chromium, type Page } from "playwright-core";

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
const cdp = need("SAP_CHROME_CDP");
const url = need("WEBGUI_URL");
const user = need("SAP_USER");
const passwordFile = need("SAP_PASSWORD_FILE").replace(/^~/, homedir());
const password = (await readFile(passwordFile, "utf8")).split(/\r?\n/)[0] ?? "";
if (!password) throw new Error(`${passwordFile} is empty`);

const ready = (page: Page) =>
  page
    .locator("#ToolbarOkCode")
    .count()
    .then((n) => n > 0)
    .catch(() => false);

const browser = await chromium.connectOverCDP(cdp, { noDefaults: true });
try {
  const context = browser.contexts()[0];
  if (!context) throw new Error("the browser has no context");
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  if (!(await ready(page))) {
    const userField = page.locator("input[name='sap-user']");
    if (await userField.count()) {
      await userField.fill(user);
      await page.locator("input[name='sap-password']").fill(password);
      const button = page.locator("#LOGON_BUTTON");
      if (await button.count()) await button.click();
      else await page.locator("input[name='sap-password']").press("Enter");
    }
    const until = Date.now() + 90_000;
    let continues = 0;
    while (!(await ready(page))) {
      if (Date.now() > until) throw new Error("no Web GUI screen 90 s after logon; look at the tab");
      await page.waitForTimeout(500);
      const body = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
      if (/not correct|incorrect|locked|not valid|denied/.test(body) && (await page.locator("input[name='sap-user']").filter({ visible: true }).count()))
        throw new Error("logon refused; not retrying");
      // Multiple logon: continue without ending the other sessions.
      const keep = page.getByText(/without ending/i).first();
      if (await keep.count().catch(() => 0)) {
        await keep.click().catch(() => {});
        await page.locator("#SESSION_QUERY_CONTINUE_BUTTON, [role='button']:has-text('Continue')").first().click().catch(() => {});
        continue;
      }
      // Information screens between logon and Web GUI carry a Continue button.
      const cont = page
        .locator("[role='button'],button,input[type='submit'],a")
        .filter({ hasText: /^\s*(Continue|OK)\s*$/i })
        .filter({ visible: true })
        .first();
      if (continues < 3 && (await cont.count().catch(() => 0))) {
        continues++;
        await cont.click().catch(() => {});
      }
    }
  }
  console.log(`logged on: ${await page.title()}`);
} finally {
  await browser.close(); // disconnects; the browser keeps running
}

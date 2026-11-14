/**
 * A Playwright test (`@playwright/test`) for SAP GUI for HTML (Web GUI).
 *
 * The spec stands alone: it logs on from SAP_WEBGUI_URL, SAP_USER and
 * SAP_PASSWORD, finds controls by their SAP scripting id (which Web GUI
 * writes into each control's `lsdata` attribute), and waits for Web GUI's
 * round trip after each action. Variables are read from SAP_VAR_<NAME>.
 *
 * `flavor: "playwright-sap"` writes the same test for the playwright-sap
 * fork, with its `locateSID` locator in place of the helper.
 *
 * Covered: command field, typing, keys, buttons, tabs, radio buttons,
 * checkboxes, double-click and value help on a control with an id. Tree
 * nodes, ALV grid cells, toolbars inside controls and dropdowns have no id
 * of their own in the page; those steps are written as `test.fixme` notes.
 * For them, replay the recording with `sap-gui-mcp-server replay`.
 *
 * A Fiori recording is written with UI5 id suffixes (`[id$="..."]`); that
 * output is a starting point and has not been run against a launchpad.
 */
import type { Capture, Check, SapTest, Step } from "../format.js";
import { doing, human } from "./words.js";

export interface PlaywrightOptions {
  flavor?: "playwright" | "playwright-sap";
}

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** A TypeScript template literal that reads the test's variables: `Order ${vars.order} saved`. */
export function tsString(text: string): string {
  if (!VAR.test(text)) return JSON.stringify(text);
  VAR.lastIndex = 0;
  const body = text.replace(/[`\\]/g, "\\$&").replace(/\$\{(?![A-Za-z_][A-Za-z0-9_]*\})/g, "\\${").replace(VAR, "${vars.$1}");
  return `\`${body}\``;
}

/** SAP virtual keys as browser keys, as the Web GUI driver sends them. */
export function browserKey(k: unknown): string | undefined {
  if (typeof k === "string") return k === "Back" ? "F3" : k;
  const n = Number(k);
  if (n === 0) return "Enter";
  if (n === 11) return "Control+s";
  if (n === 12) return "Escape";
  if (n >= 1 && n <= 10) return `F${n}`;
  if (n >= 13 && n <= 24) return `Shift+F${n - 12}`;
  if (n >= 25 && n <= 36) return `Control+F${n - 24}`;
  if (n >= 37 && n <= 48) return `Control+Shift+F${n - 36}`;
  return undefined;
}

const HELPERS_WEBGUI = `
/** Web GUI answers every action with one POST and shows a loading bar meanwhile: wait for both to end. */
async function settle(page: Page, startMs = 1500) {
  const busy = page.locator("#progressText,.lsMessageBar__icon--L,[class*='lsBusyIndicator'],[class*='urBusy'],#ur-loading").filter({ visible: true });
  await page
    .waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/sap/bc/gui/sap/its/webgui"), { timeout: startMs })
    .catch(() => {});
  await expect(busy).toHaveCount(0, { timeout: 180_000 });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(300);
  await expect(busy).toHaveCount(0, { timeout: 180_000 });
}

/** Types a command into the command field and sends it. */
async function okcode(page: Page, command: string) {
  const field = page.locator("#ToolbarOkCode");
  await field.click();
  await field.fill("");
  await field.pressSequentially(command, { delay: 20 });
  await field.press("Enter");
  await settle(page);
}

/** Web GUI needs key events, not a value set from outside: select all, delete, type. */
async function type(page: Page, field: Locator, value: string) {
  await field.focus();
  await field.press("ControlOrMeta+A");
  await field.press("Delete");
  if (value) await field.pressSequentially(value, { delay: 15 });
}

const statusBar = (page: Page) => page.locator('[id="wnd[0]/sbar_msg"]');

/** After each step: SAP reports errors in the status bar, not as a failed request. */
async function noError(page: Page) {
  // No message, no element.
  if (!(await statusBar(page).count())) return;
  const ls = (await statusBar(page).getAttribute("lsdata").catch(() => null)) ?? "";
  expect(/['"]?1['"]?:['"](ERROR|ABORT|STOP)['"]/i.test(ls), \`SAP reported an error: \${await statusBar(page).innerText().catch(() => "")}\`).toBe(false);
}

async function logon(page: Page) {
  const url = process.env.SAP_WEBGUI_URL;
  if (!url) throw new Error("set SAP_WEBGUI_URL, e.g. https://host:44300/sap/bc/gui/sap/its/webgui?sap-client=100");
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const user = page.locator("input[name='sap-user']");
  const ready = page.locator("#ToolbarOkCode");
  await expect(user.or(ready).first()).toBeVisible({ timeout: 60_000 });
  if (await user.isVisible()) {
    // The logon page clears its fields while its scripts start: fill once it is at rest.
    await page.waitForLoadState("load");
    await page.waitForTimeout(1500);
    await user.fill(process.env.SAP_USER ?? "");
    await page.locator("input[name='sap-password']").fill(process.env.SAP_PASSWORD ?? "");
    await expect(user).toHaveValue(process.env.SAP_USER ?? "");
    const button = page.locator("#LOGON_BUTTON");
    if (await button.count()) await button.click();
    else await page.locator("input[name='sap-password']").press("Enter");
  }
  // "The user is already logged on": go on without ending the other sessions.
  const keep = page.getByText(/without ending/i).first();
  await expect(keep.or(ready).first()).toBeVisible({ timeout: 90_000 });
  if (await keep.isVisible()) {
    await keep.click();
    await page.locator("#SESSION_QUERY_CONTINUE_BUTTON, [role='button']:has-text('Continue')").first().click();
  }
  await expect(ready).toBeVisible({ timeout: 90_000 });
  await settle(page, 300);
}
`;

const SID_PLAIN = `
/**
 * A control by its SAP scripting id. Web GUI writes the id into \`lsdata\`:
 * as a JavaScript literal on NetWeaver 7.5 (SID:'wnd[0]/...'), as JSON on
 * S/4HANA 2025 ("SID":"wnd[0]/..."); a backslash in the id is written twice.
 */
function sid(page: Page, id: string): Locator {
  const inLs = id.replace(/\\\\/g, "\\\\\\\\");
  const css = (s: string) => s.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"');
  // A table cell carries the id twice: on the cell and on the field inside it. The field is the control.
  const control = ':not([lsdata*="SAPTABLECSCELL"])';
  return page.locator(\`[lsdata*="\${css(\`SID:'\${inLs}'\`)}"]\${control}, [lsdata*="\${css(\`"SID":"\${inLs}"\`)}"]\${control}\`).filter({ visible: true }).first();
}
`;

const SID_PSAP = `
/** playwright-sap's locator by SAP scripting id. As shipped (1.1.6) it expects JSON in lsdata, which NetWeaver 7.5 does not write. */
const sid = (page: Page, id: string): Locator => page.locateSID(id).filter({ visible: true }).first();
`;

const HELPERS_FIORI = `
/** A UI5 control by the end of its id (the id sap_look shows). */
const ui5 = (page: Page, id: string): Locator => page.locator(\`[id$="\${id.replace(/"/g, '\\\\"')}"]\`).filter({ visible: true }).first();

async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await expect(page.locator(".sapUiLocalBusyIndicator, .sapMBusyIndicator").filter({ visible: true })).toHaveCount(0, { timeout: 60_000 });
}

async function logon(page: Page) {
  const url = process.env.SAP_FIORI_URL;
  if (!url) throw new Error("set SAP_FIORI_URL to the launchpad address");
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const user = page.locator("input[name='sap-user']");
  if (await user.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await user.fill(process.env.SAP_USER ?? "");
    await page.locator("input[name='sap-password']").fill(process.env.SAP_PASSWORD ?? "");
    await page.locator("input[name='sap-password']").press("Enter");
  }
  await settle(page);
}
`;

const fixme = (s: Step, why: string) => [`// FIXME not exported: ${human(doing(s))} — ${why}`, `test.fixme(true, ${JSON.stringify(`step not exported: ${why}`)});`];

function webguiAction(s: Step): string[] {
  const a = s.action;
  if (!a) return [];
  if (a.do === "okcode") return [`await okcode(page, ${tsString(String(a.value ?? ""))});`];
  if (a.do === "key") {
    const k = browserKey(a.key);
    return k ? [`await page.keyboard.press(${JSON.stringify(k)});`, "await settle(page);"] : fixme(s, `no browser key for SAP key ${String(a.key)}`);
  }
  const id = s.target?.id ?? (typeof a.id === "string" ? a.id : "");
  if (!id.startsWith("wnd[")) return fixme(s, `recorded with the short id "${id}" and no full id`);
  const loc = `sid(page, ${tsString(id)})`;
  switch (a.do) {
    case "set":
      return [`await type(page, ${loc}, ${tsString(String(a.value ?? ""))});`];
    case "press":
    case "select":
      if (/\/mbar\/menu\[/.test(id)) return fixme(s, "menu entries are opened through the Menu button");
      return [`await ${loc}.click();`, "await settle(page, 1200);"];
    case "focus":
      return [`await ${loc}.focus();`];
    case "dblclick":
      return [`await ${loc}.dblclick();`, "await settle(page, 1200);"];
    case "f4":
      return [`await ${loc}.focus();`, `await page.keyboard.press("F4");`, "await settle(page);"];
    case "check": {
      const on = !(a.value === false || /^(false|0|off|no)$/i.test(String(a.value)));
      return [`if ((await ${loc}.getAttribute("aria-checked")) !== "${on}") {`, `  await ${loc}.click();`, "  await settle(page, 800);", "}"];
    }
    default:
      return fixme(s, `"${a.do}" acts inside a control that has no id of its own in the page`);
  }
}

function fioriAction(s: Step): string[] {
  const a = s.action;
  if (!a) return [];
  const loc = `ui5(page, ${tsString(String(a.id ?? ""))})`;
  switch (a.do) {
    case "set":
      return [`await ${loc}.locator("input, textarea").first().fill(${tsString(String(a.value ?? ""))});`, "await settle(page);"];
    case "press":
    case "click":
    case "select":
      return [`await ${loc}.click();`, "await settle(page);"];
    case "key":
      return typeof a.key === "string" ? [`await page.keyboard.press(${JSON.stringify(a.key)});`, "await settle(page);"] : fixme(s, "SAP virtual keys belong to Web GUI");
    default:
      return fixme(s, `"${a.do}" is not exported for Fiori`);
  }
}

function subject(c: Check | Capture, fiori: boolean): { read: string; locator?: string } | undefined {
  const what = "check" in c ? c.check : c.from;
  if (what === "title") return { read: "await page.title()" };
  if (fiori) return what === "text" ? { read: `await page.locator("body").innerText()` } : undefined;
  if (what === "status") return { read: "(await statusBar(page).innerText()).trim()", locator: "statusBar(page)" };
  if (what === "text") return { read: `await page.locator("body").innerText()` };
  if (what === "field" && c.id?.startsWith("wnd[")) {
    const loc = `sid(page, ${tsString(c.id)})`;
    if ("type" in c && (c.type === "checkbox" || c.type === "radio")) return { read: `String((await ${loc}.getAttribute("aria-checked")) === "true")` };
    return { read: `await value(${loc})` };
  }
  return undefined;
}

function checkLines(c: Check, fiori: boolean): string[] {
  const s = subject(c, fiori);
  if (!s) return [`// FIXME check not exported: ${c.check} ${c.id ?? ""} ${c.op} ${JSON.stringify(c.value)}`];
  const what = JSON.stringify(c.check === "field" ? (c.label ?? c.id ?? "field") : c.check);
  if (c.op === "equals") return [`expect((${s.read}).trim(), ${what}).toBe(${tsString(c.value.trim())});`];
  if (c.op === "contains") return [`expect(${s.read}, ${what}).toContain(${tsString(c.value)});`];
  return [`expect(${s.read}, ${what}).toMatch(new RegExp(${tsString(c.value)}));`];
}

function captureLines(c: Capture, fiori: boolean): string[] {
  const s = subject(c, fiori);
  if (!s) return [`// FIXME capture of \${${c.var}} not exported`];
  if (!c.pattern) return [`vars.${c.var} = (${s.read}).trim();`, `expect(vars.${c.var}, "captured ${c.var}").not.toBe("");`];
  return ["{", `  const m = new RegExp(${JSON.stringify(c.pattern)}).exec(${s.read});`, `  expect(m, "captured ${c.var}").not.toBeNull();`, `  vars.${c.var} = m![1] ?? m![0];`, "}"];
}

export function exportPlaywright(test: SapTest, options: PlaywrightOptions = {}): string {
  const fiori = test.recorded.surface === "fiori";
  const psap = options.flavor === "playwright-sap";
  const vars = Object.entries(test.variables);
  const out: string[] = [
    `// ${test.name}`,
    `// Generated by sap-gui-mcp-server from a recording on ${test.recorded.surface}${test.recorded.system ? `, ${test.recorded.system}` : ""}${test.recorded.client ? `/${test.recorded.client}` : ""}, ${test.recorded.at}.`,
    `// Run: ${fiori ? "SAP_FIORI_URL" : "SAP_WEBGUI_URL"}=... SAP_USER=... SAP_PASSWORD=... npx playwright test`,
    ...(fiori ? ["// Fiori output is a starting point: it has not been run against a launchpad."] : []),
    `import { expect, type Locator, type Page, test } from "${psap ? "playwright-sap" : "@playwright/test"}";`,
    "",
    "// Test data: the defaults are the recorded values.",
    `const vars: Record<string, string> = {${vars.map(([k, v]) => `\n  ${k}: process.env.SAP_VAR_${k.toUpperCase()} ?? ${JSON.stringify(v.value)},${v.description ? ` // ${v.description}` : ""}`).join("")}${vars.length ? "\n" : ""}};`,
    fiori ? HELPERS_FIORI : `${psap ? SID_PSAP : SID_PLAIN}${HELPERS_WEBGUI}
/** The value of a field: an input's value, or the text of a read-only one. */
async function value(field: Locator): Promise<string> {
  return field.evaluate((e) => ("value" in e ? String((e as HTMLInputElement).value) : (e as HTMLElement).innerText));
}
`,
    ...(fiori ? [] : ["// Log off, so the run leaves no session open on the SAP system.", "test.afterEach(async ({ page }) => {", '  if (await page.locator("#ToolbarOkCode").isVisible().catch(() => false)) await okcode(page, "/nex").catch(() => {});', "});", ""]),
    `test(${JSON.stringify(test.name)}, async ({ page }) => {`,
    "  await logon(page);",
  ];
  const first = test.steps[0]?.action;
  const t = test.start.transaction;
  if (!fiori && !(first?.do === "okcode" && /^\/n\S/i.test(String(first.value ?? ""))) && t && !["SESSION_MANAGER", "SMEN", "S000"].includes(t.toUpperCase()))
    out.push("", `  // A clean start: the recording began in ${t}.`, `  await okcode(page, "/n${t}");`);
  test.steps.forEach((s, i) => {
    const lines = [
      ...(fiori ? fioriAction(s) : webguiAction(s)),
      ...(s.action && !fiori ? ["await noError(page);"] : []),
      ...(s.capture ?? []).flatMap((c) => captureLines(c, fiori)),
      ...(s.expect ?? []).flatMap((c) => checkLines(c, fiori)),
    ];
    out.push("", `  await test.step(${JSON.stringify(`${i + 1}. ${human(doing(s))}`)}, async () => {`, ...(s.note ? [`    // ${s.note.replace(/\r?\n/g, " ")}`] : []), ...lines.map((l) => `    ${l}`), "  });");
  });
  out.push("});", "");
  return out.join("\n");
}

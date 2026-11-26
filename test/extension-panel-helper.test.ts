/**
 * First run: the extension comes from the store, then `setup --extension` installs the helper. The
 * first system's form is open before the helper exists, and its password field (keychain only) used to
 * stay off until the form was closed and opened again. The panel refreshes every second: an open form
 * now follows the helper.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const panel = readFileSync(resolve(import.meta.dir, "../extension/panel.js"), "utf8");
const body = (name: string) => {
  const start = panel.indexOf(`function ${name}(`);
  return panel.slice(start, panel.indexOf("\n}\n", start));
};

test("render re-checks the password field while a form is open", () => {
  const render = body("render");
  expect(render).toContain("if (editing) updateCredFields();");
  // Only in the main view, after the rows: the form lives there.
  expect(render.indexOf("if (editing) updateCredFields();")).toBeGreaterThan(render.indexOf("renderSystems(s)"));
});

test("the field follows the helper's state, and its note is rewritten only when it changes", () => {
  const f = body("updateCredFields");
  expect(f).toContain('$("f-password").disabled = !can;');
  expect(f).toContain("const can = !!(h && h.ok && h.keychain);");
  expect(f).toContain('if ($("pw-where").textContent !== text) $("pw-where").textContent = text;');
  // It never clears what the user typed.
  expect(f).not.toContain('$("f-password").value');
});

test("the background asks again for a missing helper after a short while", () => {
  const bg = readFileSync(resolve(import.meta.dir, "../extension/background.js"), "utf8");
  expect(bg).toMatch(/helper\.ok \|\| Date\.now\(\) - helper\.at < 15000/);
});

test("pairing through the helper refreshes what the extension knows about it", () => {
  const bg = readFileSync(resolve(import.meta.dir, "../extension/background.js"), "utf8");
  const start = bg.indexOf("async function pairWithHelper(");
  const pair = bg.slice(start, bg.indexOf("\n}\n", start));
  expect(pair.lastIndexOf("await helperInfo(true);")).toBeGreaterThan(pair.indexOf("pairingCode: code"));
});

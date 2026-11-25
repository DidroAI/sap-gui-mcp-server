/**
 * The side panel is simple and quiet: colours only from the tokens (one blue accent), rounded
 * cards, the system's own font (nothing bundled, nothing fetched), sentence case on buttons and
 * headings, no "·" or "•" separators, and no SAP artwork.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(import.meta.dir, "../extension");
const css = readFileSync(resolve(dir, "panel.css"), "utf8");
const html = readFileSync(resolve(dir, "panel.html"), "utf8");
const js = readFileSync(resolve(dir, "panel.js"), "utf8");
const icons = readFileSync(resolve(dir, "icons.js"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8"));
/** The two token blocks: light (:root) and dark (the media query's :root). */
const light = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")) + 1);
const darkAt = css.indexOf("@media (prefers-color-scheme: dark)");
const dark = css.slice(darkAt, css.indexOf("}\n}", darkAt) + 3);
const rules = css.replace(light, "").replace(dark, "");

/** Sentence case: the first word capitalized, the others lower case, but names and codes. */
const NAMES = /^(SAP|Chrome|GitHub|Codex|Claude|Cursor|ECC|Web|GUI|Fiori|I|SSO|URL|macOS)$/;
function sentenceCase(label: string): boolean {
  return label
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .every((w, i) => (i === 0 ? /^[A-Z]/.test(w) : NAMES.test(w) || w === w.toLowerCase()));
}

describe("the side panel's look", () => {
  test("colours come from the tokens only; one blue accent", () => {
    // In a declaration's value, not a selector such as #add.
    expect([...rules.matchAll(/\{([^{}]*)\}/g)].flatMap((m) => m[1]!.match(/#[0-9a-f]{3,8}\b/gi) ?? [])).toEqual([]);
    expect(js.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
    expect(icons.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
    for (const t of ["--accent: #3b63f3;", "--bg: #ffffff;", "--border: #e3e6ec;"]) expect(light).toContain(t);
    expect(dark).toContain("--accent: #7b96ff;");
  });

  test("rounded: cards, buttons and fields take the radius tokens", () => {
    for (const sel of [".card {", ".btn {", ".input, .input-group {", ".status {", ".acts {"]) expect(rules.slice(rules.indexOf(sel), rules.indexOf("}", rules.indexOf(sel)))).toMatch(/border-radius: var\(--r(-sm)?\)/);
  });

  test("the system's font; nothing bundled, nothing fetched", () => {
    expect(light).toMatch(/--font: -apple-system, BlinkMacSystemFont, "Segoe UI"/);
    expect(css).not.toContain("@font-face");
    expect(existsSync(resolve(dir, "fonts"))).toBe(false);
    for (const m of css.matchAll(/url\(([^)]+)\)/g)) expect(m[1]!).not.toMatch(/https?:/);
    expect(html).not.toMatch(/(?:src="https?:|<link[^>]+href="https?:)/);
  });

  test("no '·' or '•' separators in anything the panel shows", () => {
    for (const src of [html, js]) expect(src.match(/[·•]/g) ?? []).toEqual([]);
  });

  test("buttons, headings and menu items in sentence case", () => {
    const labels = [
      ...[...html.matchAll(/<(?:button|h1|h2|summary)\b[^>]*>(?:<span[^>]*><\/span>)*([^<]+)</g)].map((m) => m[1]!.trim()),
      ...[...js.matchAll(/item\("([^"]+)"/g)].map((m) => m[1]!),
      ...[...js.matchAll(/label: (?:logsOn \? )?"([^"]+)"(?: : "([^"]+)")?/g)].flatMap((m) => [m[1]!, m[2]].filter(Boolean) as string[]),
      ...[...js.matchAll(/"(Share again|Reconnect|Update password|Go to tab|Log on|Unpair)"/g)].map((m) => m[1]!),
    ].filter((l) => l && !/[.…]$/.test(l));
    expect(labels.length).toBeGreaterThan(15);
    for (const l of labels) expect({ l, ok: sentenceCase(l) }).toEqual({ l, ok: true });
  });

  test("the product's own name and mark: no SAP logo or artwork", () => {
    for (const src of [html, js, icons]) expect(src).not.toMatch(/sap-logo|sapLogo|00b1eb/i);
    // A third party's name says "for SAP", never starts with it (SAP's trademark guidelines; the Web Store's impersonation policy).
    expect(manifest.name).toBe("UI Automation for SAP");
    expect(manifest.description).toContain("Not affiliated with SAP SE");
    expect(manifest.description.length).toBeLessThanOrEqual(132);
  });

  test("the toolbar icon opens the side panel; there is no popup and no pause switch", () => {
    expect(manifest.side_panel.default_path).toBe("panel.html");
    expect(manifest.permissions).toContain("sidePanel");
    expect(manifest.action.default_popup).toBeUndefined();
    expect(existsSync(resolve(dir, "popup.html"))).toBe(false);
    expect(html + js).not.toMatch(/Pause sharing|Resume sharing/i);
  });

  test("every icon the panel names exists", async () => {
    const { ICONS } = (await import(resolve(dir, "icons.js"))) as { ICONS: Record<string, string> };
    const named = new Set(
      [...html.matchAll(/data-icon="(\w+)"/g), ...js.matchAll(/icon\("(\w+)"\)/g), ...js.matchAll(/setIcon\([^,]+, "(\w+)"\)/g), ...js.matchAll(/\bicon: "(\w+)"/g), ...js.matchAll(/setIcon\([^,]+, [^;]*?"(\w+)" : "(\w+)"\)/g)].flatMap((m) => m.slice(1)).filter(Boolean) as string[],
    );
    expect(named.size).toBeGreaterThan(10);
    for (const n of named) expect({ n, ok: n in ICONS }).toEqual({ n, ok: true });
  });
});

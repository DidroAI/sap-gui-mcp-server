/**
 * The popup follows SAP Fiori's Horizon look as our SAP Cloud ALM MCP server
 * uses it: colours only from the tokens, Title Case on buttons and headings,
 * no "·" or "•" separators, no SAP artwork, and everything it loads bundled.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(import.meta.dir, "../extension");
const css = readFileSync(resolve(dir, "popup.css"), "utf8");
const html = readFileSync(resolve(dir, "popup.html"), "utf8");
const js = readFileSync(resolve(dir, "popup.js"), "utf8");
const icons = readFileSync(resolve(dir, "icons.js"), "utf8");
const tokens = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")) + 1);
const rules = css.replace(tokens, "");

/** Fiori's Title Case: every word capitalized but articles, conjunctions and prepositions of up to four letters. */
const SMALL = new Set(["a", "an", "the", "and", "or", "but", "nor", "for", "of", "to", "in", "on", "at", "by", "with", "from", "into", "as"]);
function titleCase(label: string): boolean {
  return label
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .every((w, i, all) => {
      // "Log On", "Sign In": the particle of a phrasal verb is capitalized.
      const particle = i > 0 && /^(log|logging|sign|signing)$/i.test(all[i - 1]!);
      return i === 0 || particle || !SMALL.has(w.toLowerCase()) ? /^[A-Z0-9]/.test(w) : w === w.toLowerCase();
    });
}

describe("the popup's look", () => {
  test("colours come from the tokens only; the tokens are Horizon's", () => {
    expect(rules.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
    expect(js.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
    expect(icons.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
    for (const t of ["--brand: #0070f2;", "--brand-hover: #0064d9;", "--focus: #0032a5;", "--text: #131e29;", "--label: #556b82;", "--line: #e5e5e5;", "--edge: #d1d6db;", "--btn-edge: #bcc3ca;", "--pos: #256f3a;", "--pos-bg: #f5fae5;", "--neg: #aa0808;"]) expect(tokens).toContain(t);
  });

  test("SAP's 72 typeface when installed, else the system's; no font bundled", () => {
    expect(tokens).toMatch(/--font: "72", "72full", -apple-system/);
    expect(css).not.toContain("@font-face");
    expect(existsSync(resolve(dir, "fonts"))).toBe(false);
  });

  test("no '·' or '•' separators in anything the popup shows", () => {
    for (const src of [html, js]) expect(src.match(/[·•]/g) ?? []).toEqual([]);
  });

  test("buttons, headings and menu items in Title Case", () => {
    const labels = [
      ...[...html.matchAll(/<(?:button|h1|h2|summary)\b[^>]*>(?:<span[^>]*><\/span>)*([^<]+)</g)].map((m) => m[1]!.trim()),
      ...[...js.matchAll(/item\("([^"]+)"/g)].map((m) => m[1]!),
      ...[...js.matchAll(/label: (?:logsOn \? )?"([^"]+)"(?: : "([^"]+)")?/g)].flatMap((m) => [m[1]!, m[2]].filter(Boolean) as string[]),
      ...[...js.matchAll(/"(Update Password|Show Tab|Resume Sharing|Pause Sharing|Extension Version)"/g)].map((m) => m[1]!),
      ...[...js.matchAll(/icon\("\w+"\), "([^"]+)"\)/g)].map((m) => m[1]!),
    ].filter((l) => l && !/[.…]$/.test(l));
    expect(labels.length).toBeGreaterThan(15);
    for (const l of labels) expect({ l, ok: titleCase(l) }).toEqual({ l, ok: true });
  });

  test("the product's own mark: no SAP logo or artwork", () => {
    for (const src of [html, js, icons]) expect(src).not.toMatch(/sap-logo|sapLogo|00b1eb/i);
    const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8"));
    // A third party's name says "for SAP", never starts with it (SAP's trademark guidelines; the Web Store's impersonation policy).
    expect(manifest.name).toMatch(/^(?!SAP).* for SAP /);
    expect(manifest.description).toContain("Not affiliated with SAP SE");
    // The Web Store's limit.
    expect(manifest.description.length).toBeLessThanOrEqual(132);
  });

  test("everything is bundled, not fetched", () => {
    for (const m of css.matchAll(/url\(([^)]+)\)/g)) expect(m[1]!).not.toMatch(/https?:/);
    // Nothing is loaded from the network (a link the user may click, such as Privacy, is not a load).
    expect(html).not.toMatch(/(?:src="https?:|<link[^>]+href="https?:)/);
  });

  test("every icon the popup names exists", async () => {
    const { ICONS } = (await import(resolve(dir, "icons.js"))) as { ICONS: Record<string, string> };
    const named = new Set(
      [...html.matchAll(/data-icon="(\w+)"/g), ...js.matchAll(/icon\("(\w+)"\)/g), ...js.matchAll(/setIcon\([^,]+, "(\w+)"\)/g), ...js.matchAll(/\bicon: "(\w+)"/g), ...js.matchAll(/setIcon\([^,]+, [^;]*?"(\w+)" : "(\w+)"\)/g)].flatMap((m) => m.slice(1)).filter(Boolean) as string[],
    );
    for (const n of ["information", "success", "warning", "error", "play", "pause", "show", "hide", "connected", "key", "edit", "open", "delete", "overflow", "sso", "person"]) named.add(n);
    for (const n of named) expect({ n, ok: n in ICONS }).toEqual({ n, ok: true });
  });
});

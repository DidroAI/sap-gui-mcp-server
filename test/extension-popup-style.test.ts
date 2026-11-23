/**
 * The popup follows the Didro platform's design rules (monorepo
 * apps/web/src/ui): colours only from the tokens, square corners except
 * dots, no small capitals, and everything it loads bundled.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(import.meta.dir, "../extension");
const css = readFileSync(resolve(dir, "popup.css"), "utf8");
const html = readFileSync(resolve(dir, "popup.html"), "utf8");
const js = readFileSync(resolve(dir, "popup.js"), "utf8");
const tokens = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")) + 1);
const rules = css.replace(tokens, "");

describe("the popup's look", () => {
  test("colours come from the tokens only", () => {
    expect(rules.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
    expect(js.match(/#[0-9a-f]{6}\b/gi) ?? []).toEqual([]);
    expect(tokens).toContain("--color-accent: #a31329;");
  });

  test("corners are square, except round dots", () => {
    for (const m of rules.matchAll(/border-radius:\s*([^;]+);/g)) expect(["50%", "0"]).toContain(m[1]!.trim());
  });

  test("no small capitals", () => {
    expect(rules).not.toMatch(/text-transform:\s*uppercase/);
  });

  test("the font and icons are bundled, not fetched", () => {
    for (const m of css.matchAll(/url\("([^"]+)"\)/g)) {
      expect(m[1]!).not.toMatch(/^https?:/);
      expect(existsSync(resolve(dir, m[1]!))).toBe(true);
    }
    expect(existsSync(resolve(dir, "fonts/OFL.txt"))).toBe(true);
    expect(html).not.toMatch(/(?:src|href)="https?:/);
  });

  test("every icon the popup names exists", async () => {
    const { ICONS } = await import("../extension/icons.js");
    const named = new Set([...html.matchAll(/data-icon="(\w+)"/g), ...js.matchAll(/icon(?:: |\()"(\w+)"/g), ...js.matchAll(/setIcon\([^,]+, "(\w+)"\)/g), ...js.matchAll(/\bicon: "(\w+)"/g)].map((m) => m[1]!));
    for (const n of ["info", "plugZap", "pause", "triangleAlert", "pencil", "externalLink", "keyRound", "trash", "eye", "eyeOff", "play"]) named.add(n);
    for (const n of named) expect({ n, ok: n in ICONS }).toEqual({ n, ok: true });
  });
});

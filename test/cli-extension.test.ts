import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledExtensionDir, extensionCommand } from "../src/cli/extension.js";

// Every test gets its own home and config folder: nothing here touches the real
// browser profiles, the pairing folder or the keychain.
let root: string;
let o: { home: string; env: Record<string, string | undefined>; keychain: false };
let out: string[];
let err: string[];
const run = (...args: string[]) => extensionCommand(args, (l) => out.push(l), (l) => err.push(l), o);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sap-ext-"));
  o = { home: join(root, "home"), env: { XDG_CONFIG_HOME: join(root, "config"), APPDATA: join(root, "appdata") }, keychain: false };
  mkdirSync(o.home);
  out = [];
  err = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("extension helper (the Chrome Web Store extension)", () => {
  test("installs the helper only, no copy of the extension", async () => {
    mkdirSync(join(o.env.XDG_CONFIG_HOME as string, "google-chrome"), { recursive: true });
    expect(await run("helper")).toBe(0);
    expect(out.join("\n")).toContain("Installed the extension's helper");
    expect(out.join("\n")).toContain("Pair with This Computer");
    expect(existsSync(join(o.home, "sap-ui-automation-extension"))).toBe(false);
  });
});

describe("extension install and uninstall", () => {
  test("install copies into a new folder, replaces an older copy, and uninstall removes it", async () => {
    const to = join(root, "ext");
    expect(await run("install", to)).toBe(0);
    expect(readFileSync(join(to, "manifest.json"), "utf8")).toBe(readFileSync(join(bundledExtensionDir(), "manifest.json"), "utf8"));
    expect(existsSync(join(to, "STORE.md"))).toBe(false);
    // A file an older version had goes away on the next install.
    writeFileSync(join(to, "old.js"), "");
    expect(await run("install", to)).toBe(0);
    expect(existsSync(join(to, "old.js"))).toBe(false);
    // uninstall finds the folder install used.
    expect(await run("uninstall")).toBe(0);
    expect(existsSync(to)).toBe(false);
    expect(out).toContain(`Removed the extension's folder ${to}`);
  });

  test("install into an empty folder works", async () => {
    const to = join(root, "empty");
    mkdirSync(to);
    expect(await run("install", to)).toBe(0);
    expect(existsSync(join(to, "manifest.json"))).toBe(true);
  });

  test("install refuses a folder that holds something else, and leaves it as it was", async () => {
    const to = join(root, "docs");
    mkdirSync(to);
    writeFileSync(join(to, "notes.txt"), "mine");
    expect(await run("install", to)).toBe(1);
    expect(err.join("\n")).toContain("is not empty and holds no copy of the extension");
    expect(existsSync(join(to, "manifest.json"))).toBe(false);
    expect(readFileSync(join(to, "notes.txt"), "utf8")).toBe("mine");
    // A file is not a folder to install into either.
    expect(await run("install", join(to, "notes.txt"))).toBe(1);
  });

  test("install refuses the package's own extension folder", async () => {
    expect(await run("install", bundledExtensionDir())).toBe(1);
    expect(existsSync(join(bundledExtensionDir(), "manifest.json"))).toBe(true);
  });

  test("uninstall leaves a folder that is not a copy of the extension", async () => {
    const to = join(root, "other");
    mkdirSync(to);
    writeFileSync(join(to, "manifest.json"), JSON.stringify({ key: "someone else's" }));
    expect(await run("uninstall", to)).toBe(0);
    expect(existsSync(join(to, "manifest.json"))).toBe(true);
    expect(out.some((l) => l.startsWith(`No copy of the extension in ${to}`))).toBe(true);
  });
});

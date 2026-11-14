import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activePortEndpoints, chromeUserDataDir, parseDevToolsActivePort } from "../src/browser/chrome.js";

describe("Chrome user-data directory", () => {
  test("macOS", () => {
    expect(chromeUserDataDir("darwin", "stable", {}, "/Users/u")).toBe("/Users/u/Library/Application Support/Google/Chrome");
    expect(chromeUserDataDir("darwin", "beta", {}, "/Users/u")).toBe("/Users/u/Library/Application Support/Google/Chrome Beta");
  });
  test("Windows", () => {
    expect(chromeUserDataDir("win32", "stable", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "C:\\Users\\u")).toBe("C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data");
    expect(chromeUserDataDir("win32", "beta", {}, "C:\\Users\\u")).toBe("C:\\Users\\u\\AppData\\Local\\Google\\Chrome Beta\\User Data");
  });
  test("Linux, with CHROME_CONFIG_HOME before XDG_CONFIG_HOME before ~/.config", () => {
    expect(chromeUserDataDir("linux", "stable", {}, "/home/u")).toBe("/home/u/.config/google-chrome");
    expect(chromeUserDataDir("linux", "beta", { XDG_CONFIG_HOME: "/x" }, "/home/u")).toBe("/x/google-chrome-beta");
    expect(chromeUserDataDir("linux", "stable", { XDG_CONFIG_HOME: "/x", CHROME_CONFIG_HOME: "/c" }, "/home/u")).toBe("/c/google-chrome");
  });
  test("other platforms have none", () => {
    expect(chromeUserDataDir("freebsd", "stable", {}, "/home/u")).toBeUndefined();
  });
});

describe("DevToolsActivePort", () => {
  test("port on the first line, browser path on the second", () => {
    expect(parseDevToolsActivePort("9222\n/devtools/browser/0a1b2c3d\n")).toBe("ws://127.0.0.1:9222/devtools/browser/0a1b2c3d");
    expect(parseDevToolsActivePort("  51234\r\n/devtools/browser/x\r\n")).toBe("ws://127.0.0.1:51234/devtools/browser/x");
  });
  test("anything else is refused", () => {
    for (const bad of ["", "9222", "abc\n/devtools/browser/x", "0\n/devtools/browser/x", "70000\n/devtools/browser/x", "9222\ndevtools"])
      expect([bad, parseDevToolsActivePort(bad)]).toEqual([bad, undefined]);
  });
});

describe("finding a running Chrome", () => {
  test("a DevToolsActivePort whose port listens is an endpoint; a stale one is not", async () => {
    const config = await mkdtemp(join(tmpdir(), "sap-gui-mcp-"));
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    try {
      await mkdir(join(config, "google-chrome"), { recursive: true });
      await mkdir(join(config, "google-chrome-beta"), { recursive: true });
      await writeFile(join(config, "google-chrome", "DevToolsActivePort"), `${port}\n/devtools/browser/abc\n`);
      await writeFile(join(config, "google-chrome-beta", "DevToolsActivePort"), "1\n/devtools/browser/stale\n");
      const tried: string[] = [];
      const found = await activePortEndpoints({ CHROME_CONFIG_HOME: config }, tried, "linux");
      expect(found.map((e) => e.url)).toEqual([`ws://127.0.0.1:${port}/devtools/browser/abc`]);
      expect(found[0]?.from).toContain("Chrome stable");
      expect(tried.join("\n")).toContain("nothing listens");
    } finally {
      server.close();
      await rm(config, { recursive: true, force: true });
    }
  });
  test("no file, no endpoint", async () => {
    const tried: string[] = [];
    expect(await activePortEndpoints({ CHROME_CONFIG_HOME: "/nonexistent-sap-gui-mcp" }, tried, "linux")).toEqual([]);
    expect(tried).toHaveLength(2);
  });
});

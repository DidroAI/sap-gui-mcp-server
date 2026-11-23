/**
 * The extension's systems as the server sees them (sap_systems, sap_logon), and
 * its helper: the native messaging host (native-host/host.mjs) and its installer.
 * No Chrome here: extension-chrome.test.ts runs the real extension.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ExtensionSystem, LogonResult } from "../src/browser/extension/relay.js";
import { bundledHostScript, EXTENSION_IDS, hostManifest, installNativeHost, NATIVE_HOST, nativeHostInstalled } from "../src/browser/extension/native.js";
import { readOrCreateCode } from "../src/browser/extension/pairing.js";
import { policyFromEnv } from "../src/core/guard.js";
import { createServer, type SystemsAccess } from "../src/server.js";
import { FakeSurface } from "./fakes.js";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "sap-ext-sys-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Talks to the host as Chrome does: one length-prefixed JSON message in, one out. */
function callHost(command: string[], msg: unknown, env: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  return new Promise((done, fail) => {
    const p = spawn(command[0]!, command.slice(1), { env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    let out = Buffer.alloc(0);
    let err = "";
    p.stdout.on("data", (d: Buffer) => {
      out = Buffer.concat([out, d]);
      if (out.length >= 4 && out.length >= 4 + out.readUInt32LE(0)) {
        p.stdin.end();
        done(JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString("utf8")));
      }
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => {
      if (out.length < 4) fail(new Error(`host exited ${code} without an answer: ${err}`));
    });
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    p.stdin.write(Buffer.concat([head, body]));
  });
}

/** A secret-tool stand-in: keeps secrets in a JSON file, reads the secret from stdin as the real one does. */
function fakeSecretTool(dir: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const store = join(dir, "secrets.json");
  writeFileSync(
    join(bin, "secret-tool"),
    `#!/usr/bin/env node
const fs = require("fs"); const f = ${JSON.stringify(store)};
const db = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
const [cmd, ...a] = process.argv.slice(2);
const attrs = a.filter((x) => !x.startsWith("--"));
const key = attrs.join("|");
fs.appendFileSync(f + ".argv", JSON.stringify(process.argv.slice(2)) + "\\n");
if (cmd === "store") { let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => { db[key] = s; fs.writeFileSync(f, JSON.stringify(db)); }); }
else if (cmd === "lookup") { if (key in db) process.stdout.write(db[key]); else process.exit(1); }
else if (cmd === "clear") { delete db[key]; fs.writeFileSync(f, JSON.stringify(db)); }
`,
  );
  chmodSync(join(bin, "secret-tool"), 0o755);
  return bin;
}

const host = [process.execPath, bundledHostScript()];

describe.skipIf(process.platform !== "linux")("the helper (native messaging host)", () => {
  test("pair: the same code as the server's pairing file, made once", async () => {
    const home = temp();
    const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
    const first = await callHost(host, { cmd: "pair" }, env);
    expect(first.ok).toBe(true);
    expect(first.code).toBe(readOrCreateCode({ XDG_CONFIG_HOME: join(home, ".config") }, "linux", home).code);
    expect((await callHost(host, { cmd: "pair" }, env)).code).toBe(first.code as string);
    // The server's own code, when the file existed first, is the one given.
    const home2 = temp();
    const server = readOrCreateCode({ XDG_CONFIG_HOME: join(home2, ".config") }, "linux", home2).code;
    expect((await callHost(host, { cmd: "pair" }, { PATH: process.env.PATH, HOME: home2, XDG_CONFIG_HOME: join(home2, ".config") })).code).toBe(server);
  });

  test("passwords go to the keychain through stdin, never on the command line; read back, deleted", async () => {
    const home = temp();
    const bin = fakeSecretTool(home);
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home };
    expect((await callHost(host, { cmd: "hello" }, env)).keychain).toBe("Secret Service (secret-tool)");
    const secret = "Made-up pw 1!";
    expect(await callHost(host, { cmd: "secret.set", id: "s1", value: secret, label: "ECC dev" }, env)).toEqual({ ok: true, keychain: "Secret Service (secret-tool)" });
    expect(readFileSync(join(home, "secrets.json.argv"), "utf8")).not.toContain(secret);
    expect(await callHost(host, { cmd: "secret.get", id: "s1" }, env)).toEqual({ ok: true, value: secret });
    expect(await callHost(host, { cmd: "secret.delete", id: "s1" }, env)).toEqual({ ok: true });
    expect((await callHost(host, { cmd: "secret.get", id: "s1" }, env)).ok).toBe(false);
  });

  test("no keychain: it says so, and keeps nothing", async () => {
    const home = temp();
    const env = { PATH: "/usr/bin:/bin", HOME: home };
    expect((await callHost(host, { cmd: "hello" }, env)).keychain).toBeNull();
    expect(await callHost(host, { cmd: "secret.set", id: "s1", value: "x" }, env)).toEqual({ ok: false, error: "no keychain on this machine" });
  });

  test("ids are checked; unknown commands refused", async () => {
    const home = temp();
    const env = { PATH: `${fakeSecretTool(home)}:${process.env.PATH}`, HOME: home };
    expect((await callHost(host, { cmd: "secret.get", id: "../x" }, env)).ok).toBe(false);
    expect(await callHost(host, { cmd: "eval" }, env)).toEqual({ ok: false, error: "unknown command" });
  });
});

describe("installing the helper", () => {
  test("manifest: our host name, the launcher, only the extension's own origin", () => {
    const m = hostManifest("/x/host.sh");
    expect(m).toEqual({ name: NATIVE_HOST, description: expect.any(String), path: "/x/host.sh", type: "stdio", allowed_origins: EXTENSION_IDS.map((id) => `chrome-extension://${id}/`) });
  });

  test("the manifest's extension id is the one the extension's key gives", () => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, "../extension/manifest.json"), "utf8")) as { key: string };
    const der = Buffer.from(manifest.key, "base64");
    const hex = new Bun.CryptoHasher("sha256").update(der).digest("hex").slice(0, 32);
    expect([...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join("")).toBe(EXTENSION_IDS[0]!);
  });

  test.skipIf(process.platform === "win32")("writes the host next to the pairing file and registers it with the browsers found", async () => {
    const home = temp();
    const config = join(home, ".config");
    mkdirSync(join(config, "google-chrome"), { recursive: true });
    mkdirSync(join(config, "chromium"), { recursive: true });
    const extra = join(home, "profile", "NativeMessagingHosts");
    const r = installNativeHost({ platform: "linux", home, env: { XDG_CONFIG_HOME: config }, extraDirs: [extra] });
    expect(r.hostDir).toBe(join(config, "sap-gui-mcp-server", "native-host"));
    expect(r.registered.sort()).toEqual([join(config, "chromium", "NativeMessagingHosts", `${NATIVE_HOST}.json`), join(config, "google-chrome", "NativeMessagingHosts", `${NATIVE_HOST}.json`), join(extra, `${NATIVE_HOST}.json`)].sort());
    expect(existsSync(join(config, "microsoft-edge"))).toBe(false);
    expect(JSON.parse(readFileSync(r.registered[0]!, "utf8")).path).toBe(r.launcher);
    expect(nativeHostInstalled("linux", home, { XDG_CONFIG_HOME: config })).toBe(true);
    // The launcher runs the copied host.
    const answer = await callHost([r.launcher], { cmd: "hello" }, { PATH: "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: config });
    expect(answer.ok).toBe(true);
  });

  test.skipIf(process.platform === "win32")("no browser folder yet: registered for Google Chrome", () => {
    const home = temp();
    const r = installNativeHost({ platform: "darwin", home, env: {} });
    expect(r.registered).toEqual([join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", `${NATIVE_HOST}.json`)]);
    expect(nativeHostInstalled("darwin", home, {})).toBe(true);
    expect(nativeHostInstalled("darwin", temp(), {})).toBe(false);
  });
});

// ---------------------------------------------------------------- the tools

const ECC: ExtensionSystem = { id: "s1", name: "ECC dev", url: "http://localhost:8010/sap/bc/gui/sap/its/webgui", kind: "webgui", client: "800", language: "EN", user: "JDOE", logon: "password", open: false };
const S4: ExtensionSystem = { id: "s2", name: "S/4 sandbox", url: "https://s4.example.com/sap/bc/ui2/flp", kind: "fiori", client: "100", language: "", user: "", logon: "sso", open: true };

async function setup(systems?: SystemsAccess) {
  const surface = new FakeSurface("webgui");
  const { server } = createServer({ policy: policyFromEnv({}), surfaces: [surface], ...(systems ? { systems } : {}) });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string }[] };
    return { error: r.isError === true, text: r.content.map((c) => c.text ?? "").join("\n") };
  };
  return { surface, client, call };
}

describe("sap_systems and sap_logon", () => {
  test("only with the extension: without it the tools do not exist, and the server says it never logs on", async () => {
    const { client } = await setup();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("sap_systems");
    expect(names).not.toContain("sap_logon");
    expect(client.getInstructions()).toContain("It never logs on.");
  });

  test("sap_systems lists name, kind, address, client, user and how it logs on; never a password", async () => {
    const { client, call } = await setup({ list: async () => [ECC, S4], logon: async () => ({}) as LogonResult });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(["sap_systems", "sap_logon"]));
    expect(client.getInstructions()).toContain("It logs on only to the systems the user registered in the Chrome extension");
    const r = await call("sap_systems");
    expect(r.text).toContain("1. ECC dev: Web GUI, http://localhost:8010/sap/bc/gui/sap/its/webgui, client 800, language EN, user JDOE. the extension logs on with the saved password");
    expect(r.text).toContain("2. S/4 sandbox: Fiori launchpad, https://s4.example.com/sap/bc/ui2/flp, client 100. single sign-on: SAP logs on by itself (open in a tab now)");
  });

  test("no session open: sap_sessions names the registered systems", async () => {
    const { call } = await setup({ list: async () => [ECC, S4], logon: async () => ({}) as LogonResult });
    expect((await call("sap_sessions")).text).toContain("Systems registered in the Chrome extension: ECC dev, S/4 sandbox. sap_logon opens one and logs on.");
  });

  test("sap_logon: logs on, then the tab's session becomes the active one", async () => {
    let surface!: FakeSurface;
    const asked: string[] = [];
    const ctx = await setup({
      list: async () => [ECC],
      logon: async (name) => {
        asked.push(name);
        // The tab is shared again once the logon page is gone: the surface finds it.
        surface.add({ id: "chrome:T9", system: "ABA", client: "800", user: "JDOE", transaction: "SMEN" });
        return { system: "ECC dev", client: "800", user: "JDOE", state: "logged_on", tabId: 9, targetId: "T9" };
      },
    });
    surface = ctx.surface;
    surface.add({ id: "chrome:T1", system: "XYZ", client: "100" });
    const r = await ctx.call("sap_logon", { system: "ecc dev" });
    expect(asked).toEqual(["ecc dev"]);
    expect(r.error).toBe(false);
    expect(r.text).toContain("Logged on to ECC dev as JDOE, client 800.");
    expect(r.text).toMatch(/\* webgui +ABA \(800\) JDOE[^\n]*id=chrome:T9/);
  });

  test("sap_logon: the extension's refusal comes back as the error, SAP's message included", async () => {
    const { call } = await setup({
      list: async () => [ECC],
      logon: async () => {
        throw new Error("SAP refused the logon to ECC dev as JDOE: Name or password is incorrect (repeat logon)");
      },
    });
    const r = await call("sap_logon", { system: "ECC dev" });
    expect(r.error).toBe(true);
    expect(r.text).toContain("Name or password is incorrect");
  });

  test("sap_logon: no password saved: the user logs on in the tab", async () => {
    const { call } = await setup({ list: async () => [ECC], logon: async () => ({ system: "ECC dev", client: "800", user: "", state: "needs_user", tabId: 3 }) });
    expect((await call("sap_logon", { system: "ECC dev" })).text).toContain("ask the user to log on in that tab");
  });
});

/**
 * The real extension in a real Chromium, against a made-up SAP logon page:
 * it pairs through its helper (no code copied), a system is registered in its
 * popup, and the server asks it to log on. The password must never cross the
 * relay: not in the extension's messages, not in the CDP traffic Playwright
 * gets, while Playwright is connected the whole time.
 *
 * Runs when SAP_TEST_CHROME names a Chromium binary (Chrome for Testing or
 * Chromium: branded Chrome no longer loads --load-extension).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { EXTENSION_IDS, installNativeHost } from "../src/browser/extension/native.js";
import { readOrCreateCode } from "../src/browser/extension/pairing.js";
import { ExtensionRelay } from "../src/browser/extension/relay.js";

const exe = process.env.SAP_TEST_CHROME;
/** The extension pages' chrome.* API, as the tests call it from the popup page. */
declare const chrome: {
  storage: { local: { set(v: Record<string, unknown>): Promise<void>; get(k: null): Promise<Record<string, any>> } };
  tabs: { query(q: Record<string, unknown>): Promise<{ id: number }[]> };
  runtime: { sendMessage(m: unknown): Promise<any> };
};
const PASSWORD = "Made-up pw 1!";
const WEBGUI = "/sap/bc/gui/sap/its/webgui";

// ---------------------------------------------------------------- a made-up SAP logon page

const posts: Record<string, string>[] = [];

function logonPage(error = ""): string {
  // Like Web GUI: the real fields replace read-only stand-ins once the page's scripts ran.
  return `<!doctype html><html><head><title>Logon</title></head><body>
<form id="SL__FORM" name="loginForm" method="POST" action="${WEBGUI}">
<input id="sap-client" name="sap-client" value="800" readonly>
<span id="slot"><input name="dummy_sap_user" readonly><input name="dummy_sap_password" readonly></span>
${error ? `<div id="LOGIN_ERROR_BLOCK" role="alert">${error}</div>` : ""}
<div id="LOGON_BUTTON" role="button" style="display:inline-block;padding:4px" onclick="document.loginForm.submit()">Log On</div>
</form>
<script>addEventListener("load", () => setTimeout(() => { document.getElementById("slot").innerHTML = '<input id="sap-user" name="sap-user"><input id="sap-password" name="sap-password" type="password">'; }, 300));</script>
</body></html>`;
}

const MULTI = `<!doctype html><html><head><title>Logon</title></head><body>
<form method="POST" action="${WEBGUI}"><input type="hidden" name="stage" value="multi">
<p>User MULTI is already logged on in client 800</p>
<label><input type="radio" name="choice" value="end"> Continue with this logon and end any other logons in system</label><br>
<label><input type="radio" name="choice" value="keep"> Continue with this logon, without ending any other logons in system</label><br>
<button id="SESSION_QUERY_CONTINUE_BUTTON" type="submit">Continue</button>
</form></body></html>`;

const APP = `<!doctype html><html><head><title>SAP Easy Access</title></head><body><input id="ToolbarOkCode"><div id="M0:46:::0:0">Menu</div>
<form id="again" method="POST" action="${WEBGUI}/echo"><input type="hidden" name="sap-user" value="JDOE"><input type="hidden" name="sap-password" id="again-pw"></form></body></html>`;

function sap(req: IncomingMessage, res: ServerResponse): void {
  const html = (body: string): void => {
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(body);
  };
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && url.pathname === WEBGUI) return html(logonPage());
  if (req.method === "GET" && url.pathname === `${WEBGUI}/app`) return html(APP);
  if (req.method === "POST" && url.pathname === `${WEBGUI}/echo`) return html(APP);
  if (req.method === "POST" && url.pathname === WEBGUI) {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const form = Object.fromEntries(new URLSearchParams(body));
      posts.push(form);
      if (process.env.DEBUG_POSTS) console.log("POST", JSON.stringify({ ...form, "sap-password": form["sap-password"] === PASSWORD ? "<right>" : `<wrong:${(form["sap-password"] ?? "").length}:${JSON.stringify((form["sap-password"] ?? "").replace(/[A-Za-z0-9]/g, "x"))}>` }));
      const go = (): void => {
        res.writeHead(303, { location: `${WEBGUI}/app` }).end();
      };
      if (form.stage === "multi") return form.choice === "keep" ? go() : html(logonPage("You ended the other logons"));
      if (form["sap-password"] !== PASSWORD) return html(logonPage("Name or password is incorrect (repeat logon)"));
      if (form["sap-user"] === "MULTI") return html(MULTI);
      return go();
    });
    return;
  }
  res.writeHead(404).end();
}

// ---------------------------------------------------------------- setup

describe.skipIf(!exe)("the extension in Chromium", () => {
  let dir: string;
  const sites: ReturnType<typeof createServer>[] = [];
  /** Three systems, one port each: a tab of one is not a tab of the others. */
  const origins: string[] = [];
  let relay: ExtensionRelay;
  let context: BrowserContext;
  let popup: Page;
  let pw: Browser;
  /** Everything the relay received from the extension, and everything it sent to Playwright, as text. */
  const wire: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sap-ext-chrome-"));
    const home = join(dir, "home");
    const config = join(home, ".config");
    mkdirSync(config, { recursive: true });
    for (let i = 0; i < 3; i++) {
      const site = createServer(sap).listen(0, "127.0.0.1");
      await new Promise((r) => site.once("listening", r));
      sites.push(site);
      origins.push(`http://127.0.0.1:${(site.address() as { port: number }).port}`);
    }

    // The relay knows the machine's code; the extension gets it only through the helper.
    relay = new ExtensionRelay({ code: readOrCreateCode({ XDG_CONFIG_HOME: config }, "linux", home).code, port: 0 });
    await relay.start();
    const r = relay as unknown as { onExtensionMessage(m: unknown): void; toCdp(m: unknown): void };
    const onExt = r.onExtensionMessage.bind(relay);
    r.onExtensionMessage = (m) => {
      wire.push(JSON.stringify(m));
      onExt(m);
    };
    const toCdp = r.toCdp.bind(relay);
    r.toCdp = (m) => {
      wire.push(JSON.stringify(m));
      toCdp(m);
    };

    // The extension, with the test site allowed up front (headless Chrome cannot answer the permission prompt).
    const ext = join(dir, "ext");
    cpSync(resolve(import.meta.dir, "../extension"), ext, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
    manifest.host_permissions = ["http://127.0.0.1/*"];
    writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest));

    // The helper, registered in the profile's own NativeMessagingHosts, with a stand-in keychain.
    const profile = join(dir, "profile");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "secret-tool"),
      // One file per account (the last argument), as the Secret Service keeps one item per attribute set.
      `#!/bin/sh\neval last=\\\${$#}\nmkdir -p ${JSON.stringify(join(dir, "keychain"))}\nf=${JSON.stringify(join(dir, "keychain"))}/"$last"\ncase "$1" in store) cat > "$f";; lookup) [ -f "$f" ] && cat "$f" || exit 1;; clear) rm -f "$f";; esac\n`,
    );
    chmodSync(join(bin, "secret-tool"), 0o755);
    installNativeHost({ platform: "linux", home, env: { XDG_CONFIG_HOME: config }, execPath: process.execPath, extraDirs: [join(profile, "NativeMessagingHosts")] });

    context = await chromium.launchPersistentContext(profile, {
      executablePath: exe ?? "",
      headless: true,
      args: ["--headless=new", `--load-extension=${ext}`, `--disable-extensions-except=${ext}`],
      ignoreDefaultArgs: ["--disable-extensions"],
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: config, PATH: `${bin}:${process.env.PATH}` },
    });
    popup = await context.newPage();
    await popup.goto(`chrome-extension://${EXTENSION_IDS[0]}/popup.html`);
    await popup.evaluate((port) => chrome.storage.local.set({ port }), relay.port);
  }, 60_000);

  afterAll(async () => {
    await pw?.close().catch(() => {});
    await context?.close().catch(() => {});
    await relay?.close().catch(() => {});
    for (const site of sites) await new Promise((r) => site.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  test("pairs through its helper: no code copied", async () => {
    await popup.click("#pair").catch(() => {}); // shown while not paired; the worker may have paired by itself already
    expect(await relay.waitForExtension(20_000)).toBe(true);
    await popup.waitForFunction(() => document.getElementById("pill-text")?.textContent === "Connected", undefined, { timeout: 10_000 });
    expect(await popup.textContent("#status-title")).toBe("Your agent is connected");
  }, 40_000);

  test("a system is registered in the popup; its password goes to the keychain", async () => {
    // No system yet: the empty state's one button.
    expect(await popup.isVisible("#add")).toBe(false);
    await popup.click("#empty-add");
    await popup.fill("#f-name", "Fake ECC");
    await popup.fill("#f-url", `${origins[0]}${WEBGUI}`);
    await popup.fill("#f-client", "800");
    await popup.fill("#f-language", "en");
    await popup.fill("#f-user", "jdoe");
    await popup.fill("#f-password", PASSWORD);
    await popup.click("#save");
    await popup.waitForSelector("#edit-view", { state: "hidden" });
    await popup.waitForSelector(".sys");
    expect(await popup.locator(".sys .meta").allTextContents()).toEqual([`${origins[0]!.slice(7)} · client 800`, "Web GUI · JDOE"]);
    expect(await popup.getAttribute(".sys .meta", "title")).toBe(`${origins[0]}${WEBGUI}`);
    expect(await popup.textContent(".sys .go")).toBe("Log on");
    const stored = await popup.evaluate(() => chrome.storage.local.get(null));
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    expect(stored.systems[0]).toMatchObject({ name: "Fake ECC", client: "800", language: "EN", user: "JDOE", passwordIn: "keychain" });
    expect(readFileSync(join(dir, "keychain", stored.systems[0].id), "utf8")).toBe(PASSWORD);
    // Two more: a user SAP asks about other logons for, and a wrong password.
    for (const [name, user, site] of [
      ["Multi", "MULTI", origins[1]],
      ["Bad", "BAD", origins[2]],
    ]) {
      await popup.click("#add");
      await popup.fill("#f-name", name!);
      await popup.fill("#f-url", `${site}${WEBGUI}`);
      await popup.fill("#f-user", user!);
      await popup.fill("#f-password", user === "BAD" ? "not it" : PASSWORD);
      await popup.click("#save");
      await popup.waitForSelector("#edit-view", { state: "hidden" });
    }
  }, 30_000);

  test("the server lists the systems, never a password", async () => {
    const systems = await relay.systems();
    expect(systems.map((x) => [x.name, x.kind, x.client, x.user, x.logon])).toEqual([
      ["Fake ECC", "webgui", "800", "JDOE", "password"],
      ["Multi", "webgui", "", "MULTI", "password"],
      ["Bad", "webgui", "", "BAD", "password"],
    ]);
    expect(JSON.stringify(systems)).not.toContain(PASSWORD);
  });

  test("logon: the extension fills SAP's page; the server gets the tab after, and never the password", async () => {
    pw = await chromium.connectOverCDP(relay.cdpUrl, { noDefaults: true, isLocal: true, timeout: 20_000 });
    const r = await relay.logon("fake ecc");
    expect(r).toMatchObject({ system: "Fake ECC", state: "logged_on", user: "JDOE", client: "800" });
    expect(typeof r.targetId).toBe("string");
    expect(posts.at(-1)).toMatchObject({ "sap-user": "JDOE", "sap-password": PASSWORD, "sap-client": "800" });
    // The tab comes back to the server once the logon page is gone.
    const page = await waitForPage(pw, `${WEBGUI}/app`);
    expect(await page.title()).toBe("SAP Easy Access");
    // A second logon finds the open tab.
    expect((await relay.logon("Fake ECC")).state).toBe("already");
    // The spy saw the traffic (the page's title went by), and no password in it.
    expect(wire.join("\n")).toContain("SAP Easy Access");
    expect(wire.join("\n")).not.toContain(PASSWORD);
  }, 90_000);

  test("a shared page that sends a password field (a logon form resent): the body stays in the browser", async () => {
    const page = await waitForPage(pw, `${WEBGUI}/app`);
    const sent = page.waitForRequest((r) => r.url().endsWith("/echo"));
    // The agent's own page script fills the field here: what matters is what comes back over the relay.
    await page.evaluate((secret) => {
      (document.getElementById("again-pw") as HTMLInputElement).value = secret;
      (document.getElementById("again") as HTMLFormElement).submit();
    }, "Second-secret 2!");
    const request = await sent;
    expect(request.postData()).toBeNull();
    expect(wire.filter((w) => w.includes("Network.requestWillBeSent") && w.includes("/echo")).length).toBeGreaterThan(0);
    // The page script above went to the extension, not back from it: the event carries no body.
    expect(wire.filter((w) => w.includes("requestWillBeSent")).join("\n")).not.toContain("Second-secret");
    await page.goBack().catch(() => {});
  }, 60_000);

  test("SAP asks about the user's other logons: the extension keeps them", async () => {
    const r = await relay.logon("Multi");
    expect(r.state).toBe("logged_on");
    expect(posts.at(-1)).toMatchObject({ stage: "multi", choice: "keep" });
    expect(wire.join("\n")).not.toContain(PASSWORD);
  }, 90_000);

  test("a refused logon comes back with SAP's message; the page's password field is empty before the server sees the tab", async () => {
    const before = posts.length;
    await expect(relay.logon("Bad")).rejects.toThrow("SAP refused the logon to Bad as BAD: Name or password is incorrect (repeat logon)");
    expect(posts.length).toBe(before + 1);
    // The logon page is shared again: Playwright finds it with nothing in its password field.
    const pages = await waitForPages(pw, (p) => p.url().endsWith(WEBGUI), 1);
    for (const p of pages) expect(await p.evaluate(() => [...document.querySelectorAll<HTMLInputElement>("input[type=password]")].map((e) => e.value).join(""))).toBe("");
    expect(wire.join("\n")).not.toContain("not it");
  }, 90_000);

  test("a SAP page that is not registered yet is proposed, with its client and language", async () => {
    const page = await context.newPage();
    await page.goto(`http://localhost:${origins[2]!.split(":")[2]}${WEBGUI}?sap-client=300&sap-language=de#x`);
    // The newest tab (the extension may not read the URL of a site it is not allowed on: neither may this test).
    const state = await popup.evaluate(async () => {
      const ids = (await chrome.tabs.query({})).map((t) => t.id);
      return chrome.runtime.sendMessage({ cmd: "state", tabId: Math.max(...ids) });
    });
    expect(state.currentTab.suggestion).toMatchObject({ sapLike: true, kind: "webgui", client: "300", language: "DE", name: "Web GUI 300", url: `http://localhost:${origins[2]!.split(":")[2]}${WEBGUI}?sap-client=300&sap-language=de` });
    await page.close();
  });

  test("an unknown system: the extension names the registered ones", async () => {
    await expect(relay.logon("nope")).rejects.toThrow('No system "nope" in the extension. Registered: Fake ECC, Multi, Bad.');
  });
});

async function waitForPages(b: Browser, match: (p: Page) => boolean, n: number, ms = 20_000): Promise<Page[]> {
  const end = Date.now() + ms;
  for (;;) {
    const pages = b.contexts().flatMap((c) => c.pages()).filter(match);
    if (pages.length >= n || Date.now() > end) return pages;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function waitForPage(b: Browser, path: string): Promise<Page> {
  const [p] = await waitForPages(b, (x) => x.url().includes(path), 1);
  if (!p) throw new Error(`no page at ${path}: ${b.contexts().flatMap((c) => c.pages()).map((x) => x.url())}`);
  return p;
}

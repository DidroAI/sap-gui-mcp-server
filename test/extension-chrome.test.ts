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
<input id="sap-client" name="sap-client" value="800" readonly><input type="hidden" name="sap-language" value="">
<div class="lsMessageBar--typeWarning" role="note"><span id="m1-txt">No switch to HTTPS occurred, so it is not secure to send a password</span></div>
<span id="slot"><input name="dummy_sap_user" readonly><input name="dummy_sap_password" readonly></span>
${error ? `<div class="lsMessageBar--typeError" role="note"><span id="m2-txt">${error}</span></div>` : ""}
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

// SAP asks for a new password: the old one was right.
const CHANGE = `<!doctype html><html><head><title>Change Password</title></head><body><form method="POST"><p>Your password has expired. Choose a new password.</p>
<input name="sap-user" value="CHANGE"><input type="password" name="sap-password"><input type="password" name="sap-system-login-passwordnew"><input type="password" name="sap-system-login-passwordrepeat"></form></body></html>`;

// An identity provider on another host: the browser signs in there, not on SAP's page.
const IDP = `<!doctype html><html><head><title>Sign in</title></head><body><form><input name="username"><input type="password" name="pw"><button>Sign in</button></form></body></html>`;

const APP = `<!doctype html><html><head><title>SAP Easy Access</title></head><body><input id="ToolbarOkCode"><div id="M0:46:::0:0">Menu</div>
<form id="again" method="POST" action="${WEBGUI}/echo"><input type="hidden" name="sap-user" value="JDOE"><input type="hidden" name="sap-password" id="again-pw"></form></body></html>`;

function sap(req: IncomingMessage, res: ServerResponse): void {
  const html = (body: string): void => {
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(body);
  };
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && url.pathname === WEBGUI && url.searchParams.has("idp")) {
    res.writeHead(302, { location: `http://localhost:${req.socket.localPort}/idp` }).end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/idp") return html(IDP);
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
      if (form["sap-user"] === "LOCKED") return html(logonPage("User is locked. Please notify the person responsible"));
      if (form["sap-user"] === "CHANGE") return html(CHANGE);
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
  /** Six systems, one port each: a tab of one is not a tab of the others. */
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
    for (let i = 0; i < 6; i++) {
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
    await popup.goto(`chrome-extension://${EXTENSION_IDS[0]}/panel.html`);
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
    await popup.waitForFunction(() => /connected$/.test(document.getElementById("status-title")?.textContent ?? ""), undefined, { timeout: 10_000 });
    expect(await popup.textContent("#status-title")).toBe("Your agent is connected");
  }, 40_000);

  test("a system is registered in the panel; its password goes to the keychain", async () => {
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
    await popup.waitForSelector(".item");
    expect(await popup.locator(".item .item-line").allTextContents()).toEqual([`Web GUIClient 800${origins[0]!.slice(7)}`, "JDOE, password saved"]);
    expect(await popup.getAttribute(".item .item-line", "title")).toBe(`${origins[0]}${WEBGUI}`);
    expect(await popup.textContent(".item .go")).toBe("Log on");
    const stored = await popup.evaluate(() => chrome.storage.local.get(null));
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    expect(stored.systems[0]).toMatchObject({ name: "Fake ECC", client: "800", language: "EN", user: "JDOE", passwordIn: "keychain" });
    expect(readFileSync(join(dir, "keychain", stored.systems[0].id), "utf8")).toBe(PASSWORD);
    // More: a user SAP asks about other logons for, a wrong password, a locked user, an expired password,
    // and a single sign-on system that sends the browser to an identity provider.
    for (const [name, user, site, sso] of [
      ["Multi", "MULTI", origins[1]],
      ["Bad", "BAD", origins[2]],
      ["Locked", "LOCKED", origins[3]],
      ["Change", "CHANGE", origins[4]],
      ["Sso", "", `${origins[5]}`, true],
    ] as [string, string, string, boolean?][]) {
      await popup.click("#add");
      await popup.fill("#f-name", name);
      await popup.fill("#f-url", `${site}${WEBGUI}${sso ? "?idp=1" : ""}`);
      if (sso) await popup.check("#f-sso");
      else {
        await popup.fill("#f-user", user);
        await popup.fill("#f-password", user === "BAD" ? "not it" : PASSWORD);
      }
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
      ["Locked", "webgui", "", "LOCKED", "password"],
      ["Change", "webgui", "", "CHANGE", "password"],
      ["Sso", "webgui", "", "", "sso"],
    ]);
    expect(JSON.stringify(systems)).not.toContain(PASSWORD);
  });

  test("logon: the extension fills SAP's page; the server gets the tab after, and never the password", async () => {
    pw = await chromium.connectOverCDP(relay.cdpUrl, { noDefaults: true, isLocal: true, timeout: 20_000 });
    const r = await relay.logon("fake ecc");
    expect(r).toMatchObject({ system: "Fake ECC", state: "logged_on", user: "JDOE", client: "800" });
    expect(typeof r.targetId).toBe("string");
    expect(posts.at(-1)).toMatchObject({ "sap-user": "JDOE", "sap-password": PASSWORD, "sap-client": "800", "sap-language": "EN" });
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

  test("a client that asks Chrome to leave bodies out still cannot fetch a password form's body", async () => {
    const page = await waitForPage(pw, `${WEBGUI}/app`);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable", { maxPostDataSize: 0 });
    const mark = wire.length - 1;
    const sent = page.waitForRequest((r) => r.url().endsWith("/echo"));
    await page.evaluate((secret) => {
      (document.getElementById("again-pw") as HTMLInputElement).value = secret;
      (document.getElementById("again") as HTMLFormElement).submit();
    }, "Third-secret 3!");
    await sent;
    // The event as the relay got it: no body, and the body cannot be fetched by its id.
    const ev = wire.map((w) => JSON.parse(w) as { method?: string; params?: { requestId?: string; request?: { url?: string; postData?: string } } }).find((m) => m.method === "Network.requestWillBeSent" && m.params?.request?.url?.endsWith("/echo") && wire.indexOf(JSON.stringify(m)) > mark);
    expect(ev?.params?.request?.postData).toBeUndefined();
    await expect(cdp.send("Network.getRequestPostData", { requestId: ev!.params!.requestId! })).rejects.toThrow(/password/);
    expect(wire.join("\n")).not.toContain("Third-secret");
    await cdp.detach().catch(() => {});
    await page.goBack().catch(() => {});
  }, 60_000);

  test("SAP asks about the user's other logons: the agent asks the user; only then are they kept, never ended", async () => {
    const asked = await refusal(relay.logon("Multi"));
    expect(asked.reason).toBe("multiple_logon");
    expect(asked.message).toContain('Ask the user what they want');
    expect(asked.message).toContain('otherLogons: "keep"');
    expect(posts.at(-1)).not.toMatchObject({ stage: "multi" });
    // The user said to keep them: the same tab answers SAP's question.
    const r = await relay.logon("Multi", { otherLogons: "keep" });
    expect(r.state).toBe("logged_on");
    expect(posts.at(-1)).toMatchObject({ stage: "multi", choice: "keep" });
    expect(wire.join("\n")).not.toContain(PASSWORD);
  }, 90_000);

  test("a wrong password: one attempt, SAP's answer, and never a second try until the user saves a new one", async () => {
    const before = posts.length;
    const r = await refusal(relay.logon("Bad"));
    expect(r.reason).toBe("wrong_password");
    expect(r.message).toContain("SAP refused the user name or password for BAD on Bad. SAP says: \"Name or password is incorrect (repeat logon)\".");
    expect(r.message).toContain("Do not ask for the password.");
    expect(posts.length).toBe(before + 1);
    // Asked again: nothing typed, nothing sent.
    expect((await refusal(relay.logon("Bad"))).reason).toBe("wrong_password");
    expect(posts.length).toBe(before + 1);
    expect((await relay.systems()).find((x) => x.name === "Bad")?.issue?.reason).toBe("wrong_password");
    // The tab stays at SAP's logon page, where the user may type a password: the server never gets it.
    await new Promise((r) => setTimeout(r, 2000));
    expect(pw.contexts().flatMap((c) => c.pages()).filter((p) => p.url().startsWith(origins[2]!))).toEqual([]);
    expect(wire.join("\n")).not.toContain("not it");
  }, 90_000);

  test("the panel says what SAP answered, and offers the one way out: a new password", async () => {
    const row = popup.locator(".item", { hasText: "Bad" });
    await row.locator(".item-note.error").waitFor();
    expect(await row.locator(".item-note").textContent()).toBe("SAP rejected the saved password.");
    // The row's button does not try that password again: it opens the form at the password.
    expect(await row.locator(".go").textContent()).toBe("Update password");
    await row.locator(".go").click();
    expect(await popup.evaluate(() => document.activeElement?.id)).toBe("f-password");
    await popup.fill("#f-password", PASSWORD);
    await popup.click("#save");
    await popup.waitForSelector("#edit-view", { state: "hidden" });
    expect((await relay.systems()).find((x) => x.name === "Bad")?.issue).toBeUndefined();
    expect((await relay.logon("Bad")).state).toBe("logged_on");
  }, 90_000);

  test("a locked user and an expired password: SAP's answer, for the agent to tell the user", async () => {
    const locked = await refusal(relay.logon("Locked"));
    expect(locked.reason).toBe("user_locked");
    expect(locked.message).toContain('SAP says: "User is locked. Please notify the person responsible"');
    const before = posts.length;
    expect((await refusal(relay.logon("Locked"))).reason).toBe("user_locked");
    expect(posts.length).toBe(before);
    const change = await refusal(relay.logon("Change"));
    expect(change.reason).toBe("password_change");
    expect(change.message).toContain("Ask the user to change it in the tab");
  }, 90_000);

  test("single sign-on through an identity provider: the user signs in there; the extension types nothing", async () => {
    const before = posts.length;
    const r = await relay.logon("Sso");
    expect(r).toMatchObject({ state: "needs_user", reason: "identity_provider" });
    expect(r.message).toContain("sends the browser to localhost");
    expect(posts.length).toBe(before);
  }, 90_000);

  test("sharing stopped from Chrome's bar: the agent is told to ask the user to share again", async () => {
    await popup.evaluate(() => chrome.storage.local.set({ paused: true }));
    const r = await refusal(relay.logon("Fake ECC"));
    expect(r.reason).toBe("paused");
    expect(r.message).toContain("Share again");
    await popup.evaluate(() => chrome.storage.local.set({ paused: false }));
  }, 30_000);

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

  test("a shared tab that comes to SAP's logon page (a timeout): the user logs on in a new tab the server never had", async () => {
    const page = await waitForPage(pw, origins[1]!);
    const before = await popup.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.id));
    await page.goto(`${origins[1]}${WEBGUI}`).catch(() => {});
    // The old tab goes; the logon page opens again in a new tab, held back from the server.
    const end = Date.now() + 15_000;
    let fresh: { id: number; url: string | undefined }[] = [];
    while (Date.now() < end) {
      const now = await popup.evaluate(async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: (t as { url?: string }).url })));
      fresh = now.filter((t) => !before.includes(t.id) && t.url?.startsWith(origins[1]!));
      if (fresh.length) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(fresh.length).toBe(1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(pw.contexts().flatMap((c) => c.pages()).filter((p) => !p.isClosed() && p.url().startsWith(`${origins[1]}${WEBGUI}`) && !p.url().includes("/app"))).toEqual([]);
  }, 60_000);

  test("an unknown system: the extension names the registered ones", async () => {
    const r = await refusal(relay.logon("nope"));
    expect(r.reason).toBe("not_registered");
    expect(r.message).toContain('No system named "nope" is registered in the extension. Registered: Fake ECC, Multi, Bad, Locked, Change, Sso.');
    expect(r.message).toContain("Never ask the user for a password.");
  });
});

/** A logon's refusal: its reason and message. */
async function refusal(p: Promise<unknown>): Promise<{ reason: string | undefined; message: string }> {
  try {
    await p;
  } catch (e) {
    return { reason: (e as { reason?: string }).reason, message: (e as Error).message };
  }
  throw new Error("the logon did not fail");
}

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

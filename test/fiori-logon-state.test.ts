import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, chromium, type Page } from "playwright-core";
import { logonState } from "../src/fiori/driver.js";

const exe = process.env.SAP_TEST_CHROME;

describe.skipIf(!exe)("Fiori: is the launchpad still logged on", () => {
  let browser: Browser;
  const servers: { stop(force?: boolean): void }[] = [];
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: exe as string, headless: true, args: ["--no-sandbox"] });
  });
  afterAll(async () => {
    await browser?.close();
    for (const s of servers) s.stop(true);
  });

  async function launchpad(startUp: { status: number; type: string; body: string; headers?: Record<string, string> }): Promise<Page> {
    // A real server: the probe goes through Playwright's request API, which page.route does not see.
    const server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/sap/bc/ui2/start_up"
          ? new Response(startUp.body, { status: startUp.status, headers: { "content-type": startUp.type, ...startUp.headers } })
          : new Response("<!doctype html><title>Home</title>", { headers: { "content-type": "text/html" } }),
    });
    servers.push(server);
    const page = await (await browser.newContext()).newPage();
    await page.goto(`http://127.0.0.1:${server.port}/sap/bc/ui2/flp`);
    return page;
  }

  test("a 401 with SAP's logon page is an expired logon", async () => {
    // As S/4 answers: with a Basic challenge, which in the page would wait for a password prompt.
    const page = await launchpad({ status: 401, type: "text/html", body: "<html><title>Anmeldung fehlgeschlagen</title></html>", headers: { "www-authenticate": 'Basic realm="SAP NetWeaver Application Server [S4H/100]"' } });
    expect(await logonState(page)).toBe("expired");
  });

  test("a 200 with a logon form is an expired logon", async () => {
    const page = await launchpad({ status: 200, type: "text/html", body: '<html><form id="logonForm" action="/logon"><input name="sap-user"></form></html>' });
    expect(await logonState(page)).toBe("expired");
  });

  test("the launchpad's start data is a live logon", async () => {
    const page = await launchpad({ status: 200, type: "application/json", body: '{"client":"100"}' });
    expect(await logonState(page)).toBe("ok");
  });

  test("a redirect to an identity provider is an expired logon", async () => {
    const page = await launchpad({ status: 302, type: "text/html", body: "", headers: { location: "https://idp.example/saml2/sso" } });
    expect(await logonState(page)).toBe("expired");
  });

  test("the probe names the tab's client: another client's sap-usercontext on the same host is not an expired logon", async () => {
    // Live 2026-11-21: ECC on localhost:8010 set sap-usercontext=sap-client=800 for host localhost; S/4 on
    // localhost:44300 then answered a request without sap-client from client 800, where the tab has no logon.
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const u = new URL(req.url);
        if (u.pathname !== "/sap/bc/ui2/start_up") return new Response("<!doctype html><title>Home</title>", { headers: { "content-type": "text/html" } });
        const client = u.searchParams.get("sap-client") ?? /sap-client=(\d+)/.exec(req.headers.get("cookie") ?? "")?.[1];
        return client === "100"
          ? new Response('{"client":"100"}', { headers: { "content-type": "application/json" } })
          : new Response("<html>logon</html>", { status: 401, headers: { "content-type": "text/html", "www-authenticate": 'Basic realm="SAP"' } });
      },
    });
    servers.push(server);
    const context = await browser.newContext();
    await context.addCookies([{ name: "sap-usercontext", value: "sap-language=EN&sap-client=800", domain: "127.0.0.1", path: "/" }]);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/sap/bc/ui2/flp?sap-client=100`);
    expect(await logonState(page)).toBe("ok");
    // No sap-client in the URL: the client the session read from the launchpad is named instead.
    await page.goto(`http://127.0.0.1:${server.port}/sap/bc/ui2/flp`);
    expect(await logonState(page, "100")).toBe("ok");
    expect(await logonState(page)).toBe("expired");
  });

  test("another launchpad without that path is not called expired", async () => {
    const page = await launchpad({ status: 404, type: "text/html", body: "<html>Not found</html>" });
    expect(await logonState(page)).toBe("unknown");
  });
});

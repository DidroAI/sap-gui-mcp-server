#!/usr/bin/env node
// The Chrome Web Store screenshots (1280×800) and the small promo tile (440×280) of the
// extension, written to store-assets/. The popup is the real popup.html, fed made-up
// systems on sap.example.com through a stand-in for chrome.runtime: never a real SAP
// system, never SAP's logo (extension/STORE.md, "Assets").
//
//   SAP_TEST_CHROME=/path/to/chrome node scripts/extension-screenshots.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ext = join(root, "extension");
const out = join(root, "store-assets");
mkdirSync(out, { recursive: true });
const version = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8")).version;

const sys = (id, name, kind, more = {}) => ({
  id,
  name,
  url: kind === "fiori" ? "https://s4.sap.example.com/sap/bc/ui2/flp" : "https://ecc.sap.example.com/sap/bc/gui/sap/its/webgui",
  client: kind === "fiori" ? "100" : "800",
  language: "EN",
  user: "JDOE",
  passwordIn: "keychain",
  sso: false,
  kind,
  open: false,
  loggingOn: false,
  ...more,
});
const base = {
  status: "connected",
  port: 47823,
  code: { set: true, managed: false, managedInvalid: false },
  helper: { ok: true, keychain: "macOS Keychain" },
  portSetting: { value: null, managed: false },
  paused: false,
  managedOrigins: [],
  shared: [],
  agent: null,
  currentTab: null,
  version,
};
const SCENES = [
  {
    file: "1-connected",
    title: "Your agent works in your SAP systems",
    text: "Register a system once. Your local agent opens it and logs on in your own Chrome.",
    state: { ...base, systems: [sys("ecc", "ECC Sales", "webgui", { open: true }), sys("s4", "S/4HANA Sandbox", "fiori"), sys("qas", "Quality System", "webgui", { passwordIn: null })], agent: { tabId: 7, title: "Display Sales Order: Overview", system: "ECC Sales" } },
  },
  {
    file: "2-logging-on",
    title: "The agent never sees your password",
    text: "The extension types it into SAP's logon page itself, from your computer's keychain.",
    state: { ...base, systems: [sys("ecc", "ECC Sales", "webgui", { open: true }), sys("s4", "S/4HANA Sandbox", "fiori", { loggingOn: true })] },
  },
  {
    file: "3-wrong-password",
    title: "One try, then it asks you",
    text: "When SAP refuses a saved password, nothing is typed again until you update it.",
    state: { ...base, systems: [sys("ecc", "ECC Sales", "webgui", { logonIssue: { reason: "wrong_password" } }), sys("s4", "S/4HANA Sandbox", "fiori", { open: true })] },
  },
  {
    file: "4-pair",
    title: "Pairs with your computer in one click",
    text: "It talks only to the local server on 127.0.0.1 and to the SAP systems you registered.",
    state: { ...base, status: "no_code", code: { set: false, managed: false, managedInvalid: false }, systems: [sys("ecc", "ECC Sales", "webgui"), sys("s4", "S/4HANA Sandbox", "fiori")] },
  },
];

// The stand-in for the extension APIs the popup calls; the scene's state comes from the page address.
const STUB = `(() => {
  const scene = new URLSearchParams(location.search).get("s");
  if (!scene) return;
  const state = JSON.parse(decodeURIComponent(scene));
  const ok = (v) => Promise.resolve(v);
  // The popup's notice about "controlled by automated test software" is for the screenshot browser, not for users.
  Object.defineProperty(navigator, "webdriver", { get: () => false });
  window.chrome = {
    runtime: { sendMessage: (m) => ok(m && m.cmd === "state" ? state : { ok: true }), getManifest: () => ({ version: state.version }), id: "store" },
    storage: { local: { get: () => ok({ "notice-seen": true }), set: () => ok() }, onChanged: { addListener() {} } },
    tabs: { query: () => ok([]), create: () => ok({}) },
    permissions: { contains: () => ok(true), request: () => ok(true) },
  };
})();`;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/frame.html") {
    const q = new URL(req.url, "http://x").searchParams;
    res.setHeader("content-type", "text/html");
    res.end(frame(q.get("title"), q.get("text"), q.get("s")));
    return;
  }
  try {
    const body = readFileSync(join(ext, path.replace(/^\/+/, "")));
    res.setHeader("content-type", TYPES[extname(path)] ?? "application/octet-stream");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function frame(title, text, scene) {
  return `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; width: 1280px; height: 800px; display: grid; grid-template-columns: 1fr 400px; gap: 64px; align-items: center; padding: 0 96px; box-sizing: border-box; background: #f2f4f7; font-family: system-ui, sans-serif; color: #1d2d3e; }
  h1 { font-size: 46px; line-height: 1.1; margin: 0 0 20px; letter-spacing: -0.01em; }
  p { font-size: 22px; line-height: 1.45; margin: 0; color: #475e75; }
  iframe { width: 400px; height: 600px; border: 0; border-radius: 12px; background: #fff; box-shadow: 0 12px 40px rgba(29,45,62,.18); }
  </style><div><h1>${esc(title)}</h1><p>${esc(text)}</p></div><iframe src="/popup.html?s=${encodeURIComponent(scene)}"></iframe>`;
}

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const browser = await chromium.launch(process.env.SAP_TEST_CHROME ? { executablePath: process.env.SAP_TEST_CHROME } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(STUB);
  for (const s of SCENES) {
    const q = new URLSearchParams({ title: s.title, text: s.text, s: encodeURIComponent(JSON.stringify(s.state)) });
    await page.goto(`http://127.0.0.1:${port}/frame.html?${q}`);
    await page.waitForTimeout(800);
    // The frame as tall as the popup's content, as Chrome sizes a popup (at most 600 px).
    await page.evaluate(() => {
      const f = document.querySelector("iframe");
      const body = f.contentDocument.body;
      const bottom = Math.max(...[...body.children].filter((c) => !c.hidden).map((c) => c.getBoundingClientRect().bottom));
      const h = Math.min(600, Math.ceil(bottom));
      f.style.height = `${h}px`;
      f.style.width = `${Math.ceil(Math.max(...[...body.children].filter((c) => !c.hidden).map((c) => c.getBoundingClientRect().right)))}px`;
    });
    await page.screenshot({ path: join(out, `${s.file}.png`) });
    console.log(join(out, `${s.file}.png`));
  }
  // The small promo tile: the extension's own icon and the name, on a flat background.
  const tile = await browser.newPage({ viewport: { width: 440, height: 280 } });
  await tile.goto(`http://127.0.0.1:${port}/frame.html?tile=1`);
  await tile.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;width:440px;height:280px;display:grid;place-items:center;background:#1d2d3e;font-family:system-ui,sans-serif;color:#fff}
    img{display:block;width:88px;height:88px;margin:0 auto 16px}
    h1{font-size:28px;margin:0;text-align:center;font-weight:600}p{margin:6px 0 0;text-align:center;color:#c5d2df;font-size:16px}</style>
    <div><img src="http://127.0.0.1:${port}/icons/128.png" alt=""><h1>Agent Connector</h1><p>for SAP Systems</p></div>`);
  await tile.waitForTimeout(300);
  await tile.screenshot({ path: join(out, "promo-440x280.png") });
  console.log(join(out, "promo-440x280.png"));
} finally {
  await browser.close();
  server.close();
}

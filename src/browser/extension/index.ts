/**
 * The sap-gui-mcp-server extension as a way into the user's Chrome: no remote
 * debugging switch, no "Allow?" prompt per connection, and only the tabs of
 * the sites the user allowed in the extension.
 *
 * One relay per process (relay.ts), started on first use. Its CDP endpoint is
 * handed to Playwright's `connectOverCDP` like any other Chrome endpoint.
 */
import type { DoctorCheck } from "../../core/types.js";
import { formatCode, readOrCreateCode } from "./pairing.js";
import { ExtensionRelay, type ExtensionInfo, type ExtensionSystem, type LogonResult } from "./relay.js";

type Env = Record<string, string | undefined>;

/** An MV3 service worker sleeps after 30 s idle; when asleep it reconnects on its next wake-up. */
const DEFAULT_WAIT_S = 35;

const INSTALL = `Install the sap-gui-mcp-server extension: run \`npx -y sap-gui-mcp-server extension install\`, then in Chrome open chrome://extensions, switch on Developer mode, click "Load unpacked" and choose the folder it names.`;
const PAIR = `Pair it: click the extension's icon in Chrome's toolbar and "Pair with this computer" (or run \`sap-gui-mcp-server extension pair\` and paste the code it prints).`;

let relay: ExtensionRelay | undefined;
/** When the relay started listening: the wait for the extension counts from then, not again for every call. */
let startedAt = 0;
/** However long the relay has been waiting already, a call still gives the extension this long. */
const MIN_WAIT_MS = 2000;
let starting: Promise<ExtensionRelay> | undefined;

/** SAP_EXTENSION_WAIT seconds, else 35 s. */
function defaultWaitMs(env: Env): number {
  const s = Number(env.SAP_EXTENSION_WAIT);
  return (Number.isFinite(s) && s >= 0 && env.SAP_EXTENSION_WAIT?.trim() ? s : DEFAULT_WAIT_S) * 1000;
}

function wantedPort(env: Env): number | undefined {
  const raw = env.SAP_EXTENSION_PORT?.trim();
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`SAP_EXTENSION_PORT must be a port number (got "${raw}")`);
  return port;
}

/** The process's relay, started once. */
export async function extensionRelay(env: Env = process.env): Promise<ExtensionRelay> {
  if (relay) return relay;
  if (starting) return starting;
  starting = (async () => {
    const port = wantedPort(env);
    const r = new ExtensionRelay({ code: readOrCreateCode(env).code, ...(port !== undefined ? { port } : {}) });
    await r.start();
    startedAt = Date.now();
    relay = r;
    return r;
  })();
  try {
    return await starting;
  } finally {
    starting = undefined;
  }
}

/**
 * Waits for the extension. Doctor (`stopOnRefusal`) stops at a refusal (wrong code, busy): the extension tries
 * again only every 30 s, with the same code. The server itself waits on: any local program can send a bad
 * `auth`, and must not be able to cut the server's wait short.
 */
async function connected(r: ExtensionRelay, ms: number, stopOnRefusal = false): Promise<boolean> {
  if (r.extensionInfo().connected) return true;
  if (!stopOnRefusal) return r.waitForExtension(ms);
  if (r.extensionInfo().lastRefusal) return false;
  let poll: ReturnType<typeof setInterval> | undefined;
  const refused = new Promise<boolean>((resolve) => {
    poll = setInterval(() => {
      if (r.extensionInfo().lastRefusal && !r.extensionInfo().connected) resolve(false);
    }, 200);
  });
  try {
    return await Promise.race([r.waitForExtension(ms), refused]);
  } finally {
    clearInterval(poll);
  }
}

/** The one step to take when no extension is connected. */
function missingStep(info: ExtensionInfo, waitedS: number): string {
  if (info.lastRefusal === "code")
    return `The sap-gui-mcp-server extension tried to connect with a pairing code that does not match this server's. Run \`sap-gui-mcp-server extension pair\` and paste the code it prints into the extension's popup.`;
  if (info.attempts > 0) return `The sap-gui-mcp-server extension reached the server but did not pair. ${PAIR}`;
  return `No sap-gui-mcp-server extension connected within ${waitedS} s. ${INSTALL} Then: ${PAIR}`;
}

/**
 * The CDP endpoint of the extension relay, once the extension is connected
 * (waits up to `waitMs`, by default SAP_EXTENSION_WAIT seconds or 35 s, since
 * the extension's worker may be asleep). Throws with the one step to take.
 */
export async function extensionEndpoint(env: Env = process.env, waitMs: number = defaultWaitMs(env)): Promise<{ url: string; from: string }> {
  const r = await extensionRelay(env);
  // The first call waits for the worker to wake; later ones (another surface, the next tool call) do not wait it all again.
  const left = Math.max(MIN_WAIT_MS, startedAt + waitMs - Date.now());
  if (!(await connected(r, Math.min(waitMs, left)))) throw new Error(missingStep(r.extensionInfo(), Math.round((Date.now() - startedAt) / 1000)));
  const version = /(?:Chrome|Chromium)\/([\d.]+)/.exec(r.extensionInfo().userAgent ?? "")?.[1] ?? "";
  return { url: r.cdpUrl, from: `the sap-gui-mcp-server extension in Chrome${version ? ` ${version}` : ""} (port ${r.port})` };
}

/** The relay, once the extension is connected (waits like extensionEndpoint). */
async function connectedRelay(env: Env): Promise<ExtensionRelay> {
  const r = await extensionRelay(env);
  const waitMs = defaultWaitMs(env);
  const left = Math.max(MIN_WAIT_MS, startedAt + waitMs - Date.now());
  if (!(await connected(r, Math.min(waitMs, left)))) throw new Error(missingStep(r.extensionInfo(), Math.round((Date.now() - startedAt) / 1000)));
  return r;
}

/** The SAP systems registered in the extension: what sap_systems lists and sap_logon opens. */
export const extensionSystems = {
  list: async (env: Env = process.env): Promise<ExtensionSystem[]> => (await connectedRelay(env)).systems(),
  logon: async (system: string, env: Env = process.env): Promise<LogonResult> => (await connectedRelay(env)).logon(system),
};

/** Setup checks: is the extension installed, paired, connected; when not, the one step to take. */
export async function extensionDoctor(env: Env = process.env, waitMs: number = defaultWaitMs(env)): Promise<DoctorCheck[]> {
  const check = "Chrome extension";
  let r: ExtensionRelay;
  try {
    r = await extensionRelay(env);
  } catch (e) {
    return [{ ok: false, check, detail: (e as Error).message, fix: "Close the other program on these ports, or set SAP_EXTENSION_PORT and the same port in the extension's options." }];
  }
  const left = Math.max(MIN_WAIT_MS, startedAt + waitMs - Date.now());
  if (!(await connected(r, Math.min(waitMs, left), true))) {
    const info = r.extensionInfo();
    if (info.lastRefusal === "code") return [{ ok: false, check, detail: "the extension is installed but holds another pairing code", fix: 'Click its icon and "Pair again" (or run `sap-gui-mcp-server extension pair` and paste the code it prints).' }];
    if (info.attempts > 0) return [{ ok: false, check, detail: "the extension is installed but not paired with this server", fix: PAIR }];
    return [{ ok: false, check, detail: `no sap-gui-mcp-server extension connected to port ${r.port} within ${Math.round(waitMs / 1000)} s`, fix: `${INSTALL} Then: ${PAIR}` }];
  }
  const info = r.extensionInfo();
  const version = /(?:Chrome|Chromium)\/([\d.]+)/.exec(info.userAgent ?? "")?.[1];
  const systems = await r.systems().catch(() => undefined);
  const { nativeHostInstalled } = await import("./native.js");
  const out: DoctorCheck[] = [
    {
      ok: true,
      check,
      detail: `extension ${info.extensionVersion || "?"} connected and paired${version ? ` in Chrome ${version}` : ""} (port ${r.port}); ${info.tabs} tab(s) of registered systems open`,
    },
    systems?.length
      ? { ok: true, check: "SAP systems", detail: systems.map((x) => `${x.name}${x.logon === "password" ? " (logs on by itself)" : x.logon === "sso" ? " (single sign-on)" : ""}`).join(", ") }
      : { ok: false, check: "SAP systems", detail: "none registered in the extension", fix: "Open your SAP system in Chrome, click the extension's icon and \"Add the SAP page I'm on\"." },
  ];
  if (!nativeHostInstalled()) out.push({ ok: true, check: "Extension helper", detail: "not installed: saved passwords are kept in the Chrome profile, not in the keychain. Run `sap-gui-mcp-server extension install` to add it" });
  return out;
}

/** Stops the relay: the extension and Playwright see their sockets close. */
export async function stopExtensionRelay(): Promise<void> {
  const r = relay ?? (starting ? await starting.catch(() => undefined) : undefined);
  relay = undefined;
  await r?.close();
}

/** What `sap-gui-mcp-server extension pair` prints. */
export function extensionPairCommand(env: Env = process.env): string[] {
  const { code, file } = readOrCreateCode(env);
  return [
    "Pairing code for the sap-gui-mcp-server extension:",
    "",
    `  ${formatCode(code)}`,
    "",
    file ? `It is kept in ${file} (readable only by you).` : "It comes from SAP_EXTENSION_CODE.",
    "In Chrome, click the SAP systems extension's icon, open \"Pair with a code instead\" and paste the code. Pair once per Chrome profile.",
    "Not installed yet? Run `sap-gui-mcp-server extension install`, open chrome://extensions, switch on Developer mode, click \"Load unpacked\" and choose the folder it names.",
  ];
}

export { ExtensionRelay, type ExtensionInfo, type ExtensionSystem, type LogonResult } from "./relay.js";
export { formatCode, normalizeCode, pairingFile, readOrCreateCode } from "./pairing.js";

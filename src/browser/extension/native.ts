/**
 * The extension's native messaging host (native-host/host.mjs): installed by
 * `sap-ui-automation extension install`, started by Chrome for this extension
 * only. It hands the extension the pairing code (no copying by hand) and keeps
 * saved SAP passwords in the OS keychain. It does not talk to the server.
 *
 * Installing means: copy host.mjs next to the pairing file, write a launcher
 * that runs it with this Node (or Bun), and register the host with each
 * Chromium browser the user has: a manifest in its NativeMessagingHosts folder
 * (macOS, Linux), or a registry key (Windows).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { pairingFile } from "./pairing.js";

type Env = Record<string, string | undefined>;

/** The host's name, as the extension calls it (chrome.runtime.sendNativeMessage). */
export const NATIVE_HOST = "ai.didro.sap_ui_automation";
/**
 * The extension's id: fixed by the "key" in extension/manifest.json, so an
 * unpacked copy has the same id on every machine. A Web Store build gets its own
 * id, to be added here.
 */
export const EXTENSION_IDS: readonly string[] = ["ojokfbbfoignpfeamomeappgfhapehma"];

/** The browsers' user-level NativeMessagingHosts folders, with the browser folder that must exist for each. */
export function hostManifestDirs(platform: NodeJS.Platform = process.platform, home: string = homedir(), env: Env = process.env): { browser: string; dir: string }[] {
  if (platform === "darwin") {
    const base = posix.join(home, "Library", "Application Support");
    return ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Chromium", "Microsoft Edge", "BraveSoftware/Brave-Browser", "Vivaldi"].map((b) => ({ browser: posix.join(base, b), dir: posix.join(base, b, "NativeMessagingHosts") }));
  }
  if (platform === "linux") {
    const base = env.XDG_CONFIG_HOME || posix.join(home, ".config");
    return ["google-chrome", "google-chrome-beta", "chromium", "microsoft-edge", "BraveSoftware/Brave-Browser", "vivaldi"].map((b) => ({ browser: posix.join(base, b), dir: posix.join(base, b, "NativeMessagingHosts") }));
  }
  return [];
}

/** Windows: the registry keys Chrome, Edge and Chromium read (HKCU). */
const WINDOWS_KEYS = ["Software\\Google\\Chrome", "Software\\Microsoft\\Edge", "Software\\Chromium", "Software\\BraveSoftware\\Brave-Browser"].map((k) => `HKCU\\${k}\\NativeMessagingHosts\\${NATIVE_HOST}`);

/** The host script shipped with the package: <package>/native-host/host.mjs, from src or dist alike. */
export function bundledHostScript(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "native-host", "host.mjs");
}

export interface InstallOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: Env;
  /** The runtime the launcher starts host.mjs with; default: this process's (node, or bun). */
  execPath?: string;
  /** Extra NativeMessagingHosts folders, written whether or not their browser exists (tests: a profile's own folder). */
  extraDirs?: string[];
}

export interface InstallResult {
  /** Where host.mjs and its launcher are. */
  hostDir: string;
  launcher: string;
  /** Manifests written (or registry keys set on Windows). */
  registered: string[];
}

/** The host's manifest for Chrome. */
export function hostManifest(launcher: string): Record<string, unknown> {
  return {
    name: NATIVE_HOST,
    description: "sap-ui-automation helper: pairing and saved SAP passwords for the Chrome extension",
    path: launcher,
    type: "stdio",
    allowed_origins: EXTENSION_IDS.map((id) => `chrome-extension://${id}/`),
  };
}

/** Copies the host next to the pairing file and registers it with every Chromium browser found. */
export function installNativeHost(options: InstallOptions = {}): InstallResult {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const path = platform === "win32" ? win32 : posix;
  const hostDir = path.join(path.dirname(pairingFile(platform, env, home)), "native-host");
  mkdirSync(hostDir, { recursive: true, mode: 0o700 });
  const script = path.join(hostDir, "host.mjs");
  copyFileSync(bundledHostScript(), script);
  const runtime = options.execPath ?? process.execPath;
  let launcher: string;
  if (platform === "win32") {
    launcher = path.join(hostDir, "host.bat");
    // The Node.js that installed it, else whichever is on PATH (an upgrade may have moved the first).
    writeFileSync(launcher, `@echo off\r\nif exist "${runtime}" (\r\n  "${runtime}" "${script}" %*\r\n) else (\r\n  node "${script}" %*\r\n)\r\n`);
  } else {
    launcher = path.join(hostDir, "host.sh");
    const q = (x: string) => `'${x.replace(/'/g, "'\\''")}'`;
    // The Node.js (or Bun) that installed it, else node from the usual places (Homebrew, Volta, the newest
    // nvm version): an upgrade removes the first, and Chrome starts the helper with a bare PATH.
    writeFileSync(
      launcher,
      `#!/bin/sh\n# sap-ui-automation helper for the Chrome extension (written by \`sap-ui-automation extension install\`)\n` +
        `if [ -x ${q(runtime)} ]; then exec ${q(runtime)} ${q(script)} "$@"; fi\n` +
        `PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/usr/bin:$HOME/.volta/bin"\n` +
        // nvm keeps each version in its own folder: the newest one.
        `if ! command -v node >/dev/null 2>&1; then for n in $(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V -r); do PATH="$PATH:$n"; break; done; fi\n` +
        `exec node ${q(script)} "$@"\n`,
    );
    chmodSync(launcher, 0o755);
  }
  const manifest = JSON.stringify(hostManifest(launcher), null, 2);
  const registered: string[] = [];
  if (platform === "win32") {
    const file = path.join(hostDir, `${NATIVE_HOST}.json`);
    writeFileSync(file, manifest);
    for (const key of WINDOWS_KEYS) {
      const r = spawnSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", file, "/f"], { stdio: "ignore", windowsHide: true });
      if (r.status === 0) registered.push(key);
    }
  } else {
    const found = hostManifestDirs(platform, home, env).filter((d) => existsSync(d.browser));
    // No browser folder yet (Chrome never started): register for Google Chrome anyway.
    const dirs = [...new Set([...(found.length ? found : hostManifestDirs(platform, home, env).slice(0, 1)).map((d) => d.dir), ...(options.extraDirs ?? [])])];
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${NATIVE_HOST}.json`);
      writeFileSync(file, manifest);
      registered.push(file);
    }
  }
  return { hostDir, launcher, registered };
}

/** Every place the host was installed: manifests, Windows keys, its folder. */
export interface UninstallResult {
  removed: string[];
  keychainItems: number;
}

/**
 * Removes the helper: its manifests from every browser, its registry keys (Windows), its folder, and the
 * passwords the extension saved through it (keychain items of the service "sap-ui-automation").
 */
export function uninstallNativeHost(options: { platform?: NodeJS.Platform; home?: string; env?: Env; keychain?: boolean } = {}): UninstallResult {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const path = platform === "win32" ? win32 : posix;
  const removed: string[] = [];
  if (platform === "win32") {
    for (const key of WINDOWS_KEYS) if (spawnSync("reg", ["delete", key, "/f"], { stdio: "ignore", windowsHide: true }).status === 0) removed.push(key);
  } else {
    for (const { dir } of hostManifestDirs(platform, home, env)) {
      const file = path.join(dir, `${NATIVE_HOST}.json`);
      if (existsSync(file)) {
        rmSync(file, { force: true });
        removed.push(file);
      }
    }
  }
  const hostDir = path.join(path.dirname(pairingFile(platform, env, home)), "native-host");
  if (existsSync(hostDir)) {
    rmSync(hostDir, { recursive: true, force: true });
    removed.push(hostDir);
  }
  let keychainItems = 0;
  if (options.keychain !== false) {
    if (platform === "darwin") {
      // One item per saved system: delete until there is none left.
      for (let i = 0; i < 500 && spawnSync("/usr/bin/security", ["delete-generic-password", "-s", "sap-ui-automation"], { stdio: "ignore" }).status === 0; i++) keychainItems++;
    } else if (platform === "linux") {
      if (spawnSync("secret-tool", ["clear", "service", "sap-ui-automation"], { stdio: "ignore" }).status === 0) keychainItems = -1;
    } else if (platform === "win32") {
      const dir = win32.join(win32.dirname(pairingFile(platform, env, home)), "secrets");
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
        keychainItems = -1;
      }
    }
  }
  return { removed, keychainItems };
}

/** Does the installed helper answer? Runs its launcher with a "hello" message, as Chrome would. */
export function nativeHostAnswers(platform: NodeJS.Platform = process.platform, home: string = homedir(), env: Env = process.env): { ok: boolean; keychain?: string | null; error?: string } {
  let launcher: string | undefined;
  for (const { dir } of hostManifestDirs(platform, home, env)) {
    try {
      launcher = (JSON.parse(readFileSync(posix.join(dir, `${NATIVE_HOST}.json`), "utf8")) as { path?: string }).path;
      if (launcher) break;
    } catch {}
  }
  if (platform === "win32") launcher = win32.join(win32.dirname(pairingFile(platform, env, home)), "native-host", "host.bat");
  if (!launcher || !existsSync(launcher)) return { ok: false, error: "not installed" };
  const body = Buffer.from(JSON.stringify({ cmd: "hello" }));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  const r = spawnSync(launcher, ["chrome-extension://doctor/"], { input: Buffer.concat([head, body]), timeout: 10_000, windowsHide: true, shell: platform === "win32" });
  try {
    const out = r.stdout as Buffer;
    const answer = JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString("utf8")) as { ok?: boolean; keychain?: string | null };
    return answer.ok ? { ok: true, keychain: answer.keychain ?? null } : { ok: false, error: "it answered with an error" };
  } catch {
    return { ok: false, error: `it did not answer (${String(r.stderr ?? "").trim().split("\n")[0] || `exit ${r.status}`}): run install again` };
  }
}

/** Is the host registered for at least one browser (for doctor)? The launcher must exist too. */
export function nativeHostInstalled(platform: NodeJS.Platform = process.platform, home: string = homedir(), env: Env = process.env): boolean {
  for (const { dir } of hostManifestDirs(platform, home, env)) {
    const file = posix.join(dir, `${NATIVE_HOST}.json`);
    try {
      const m = JSON.parse(readFileSync(file, "utf8")) as { path?: string };
      if (m.path && existsSync(m.path)) return true;
    } catch {}
  }
  if (platform === "win32") return existsSync(win32.join(win32.dirname(pairingFile(platform, env, home)), "native-host", `${NATIVE_HOST}.json`));
  return false;
}

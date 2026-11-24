// sap-ui-automation helper: the native messaging host of the sap-ui-automation Chrome extension.
//
// Chrome starts it, for this extension only (allowed_origins in its manifest), once per message:
// - "pair": the machine's pairing code, the one the server uses, so the user never copies it by hand;
// - "secret.*": SAP passwords the user saved in the extension, kept in the OS keychain
//   (macOS Keychain, the Secret Service through secret-tool on Linux, DPAPI on Windows).
//
// It never talks to the MCP server, and never writes a password to a log, a file in clear or the command line.
// Plain Node.js with no dependencies: `sap-ui-automation extension install` copies it next to the pairing file.
import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const SERVICE = "sap-ui-automation";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 26;
const MAX_MESSAGE = 64 * 1024;

// The same as extension/code.js and src/browser/extension/pairing.ts (test/pairing-parity.test.ts checks it).
export const normalizeCode = (s) =>
  String(s || "")
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/[^0-9A-Z]/g, "");
export const formatCode = (c) => normalizeCode(c).replace(/(.{5})(?=.)/g, "$1-");

// The same file as src/browser/extension/pairing.ts (pairingFile).
function configDir(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === "win32") return win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), SERVICE);
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", SERVICE);
  return posix.join(env.XDG_CONFIG_HOME || posix.join(home, ".config"), SERVICE);
}

// The same rules as readOrCreateCode: read the file, else make a code with mode 0600.
function pairingCode() {
  const dir = configDir();
  const file = (process.platform === "win32" ? win32 : posix).join(dir, "extension-pairing");
  try {
    const code = normalizeCode(readFileSync(file, "utf8"));
    if (code.length === CODE_LENGTH) return code;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CROCKFORD[randomInt(32)];
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${formatCode(code)}\n`, { mode: 0o600 });
  return code;
}

// ---------------------------------------------------------------- keychains

const validId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);

function onPath(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
  return r.status === 0;
}

const run = (cmd, args, input) => spawnSync(cmd, args, { input: input ?? "", encoding: "utf8", windowsHide: true, timeout: 20_000 });

const macos = {
  name: "macOS Keychain",
  available: () => process.platform === "darwin" && existsSync("/usr/bin/security"),
  // `security -i` reads its command from stdin, and -X takes the password in hex: it never shows in the process list.
  set(id, value, label) {
    const hex = Buffer.from(value, "utf8").toString("hex");
    // One line of `security -i` input: no quote, backslash or line break may get into it.
    const quote = (s) => `"${String(s).replace(/["\\\r\n]/g, " ")}"`;
    const r = run("/usr/bin/security", ["-i"], `add-generic-password -U -a ${quote(id)} -s ${quote(SERVICE)} -l ${quote(label)} -X ${hex}\n`);
    if (r.status !== 0) throw new Error(`the keychain refused the password (${(r.stderr || "").trim().split("\n")[0] || r.status})`);
  },
  get(id) {
    const r = run("/usr/bin/security", ["find-generic-password", "-a", id, "-s", SERVICE, "-w"]);
    if (r.status !== 0) return null;
    return r.stdout.replace(/\n$/, "");
  },
  delete(id) {
    run("/usr/bin/security", ["delete-generic-password", "-a", id, "-s", SERVICE]);
  },
};

const secretTool = {
  name: "Secret Service (secret-tool)",
  available: () => process.platform === "linux" && onPath("secret-tool"),
  set(id, value, label) {
    const r = run("secret-tool", ["store", `--label=${label}`, "service", SERVICE, "account", id], value);
    if (r.status !== 0) throw new Error(`secret-tool refused the password (${(r.stderr || "").trim().split("\n")[0] || r.status})`);
  },
  get(id) {
    const r = run("secret-tool", ["lookup", "service", SERVICE, "account", id]);
    return r.status === 0 && r.stdout !== "" ? r.stdout.replace(/\n$/, "") : null;
  },
  delete(id) {
    run("secret-tool", ["clear", "service", SERVICE, "account", id]);
  },
};

// DPAPI: the file can be decrypted only by this Windows user on this machine. Passwords go through stdin.
const dpapiFile = (id) => win32.join(configDir(), "secrets", `${id}.dpapi`);
const PS = ["-NoProfile", "-NonInteractive", "-Command"];
const dpapi = {
  name: "Windows (DPAPI)",
  available: () => process.platform === "win32",
  set(id, value) {
    const r = run("powershell.exe", [...PS, "$s = [Console]::In.ReadToEnd(); ConvertTo-SecureString -String $s -AsPlainText -Force | ConvertFrom-SecureString"], value);
    if (r.status !== 0 || !r.stdout.trim()) throw new Error("Windows could not protect the password");
    mkdirSync(win32.dirname(dpapiFile(id)), { recursive: true });
    writeFileSync(dpapiFile(id), r.stdout.trim());
  },
  get(id) {
    if (!existsSync(dpapiFile(id))) return null;
    const blob = readFileSync(dpapiFile(id), "utf8").trim();
    const r = run("powershell.exe", [...PS, "$b = [Console]::In.ReadToEnd().Trim(); $p = ConvertTo-SecureString -String $b; [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p)))"], blob);
    return r.status === 0 ? r.stdout : null;
  },
  delete(id) {
    rmSync(dpapiFile(id), { force: true });
  },
};

const keychain = () => [macos, secretTool, dpapi].find((k) => k.available()) ?? null;

// ---------------------------------------------------------------- messages

function handle(msg) {
  switch (msg && msg.cmd) {
    case "hello":
      return { ok: true, version: 1, keychain: keychain()?.name ?? null };
    case "pair":
      return { ok: true, code: pairingCode() };
    case "secret.set": {
      const k = keychain();
      if (!k) return { ok: false, error: "no keychain on this machine" };
      if (!validId(msg.id) || typeof msg.value !== "string" || !msg.value) return { ok: false, error: "bad request" };
      const label = `sap-ui-automation: ${String(msg.label || msg.id).slice(0, 80)}`;
      k.set(msg.id, msg.value, label);
      // Read it back: a keychain that stores but cannot give back would lose the password silently.
      if (k.get(msg.id) !== msg.value) {
        k.delete(msg.id);
        return { ok: false, error: `${k.name} did not give the password back` };
      }
      return { ok: true, keychain: k.name };
    }
    case "secret.get": {
      const k = keychain();
      if (!k || !validId(msg.id)) return { ok: false, error: k ? "bad request" : "no keychain on this machine" };
      const value = k.get(msg.id);
      return value === null ? { ok: false, error: "no password saved" } : { ok: true, value };
    }
    case "secret.delete": {
      const k = keychain();
      if (k && validId(msg.id)) k.delete(msg.id);
      return { ok: true };
    }
    default:
      return { ok: false, error: "unknown command" };
  }
}

// Native messaging framing: 32-bit length in native byte order (little-endian on every platform Chrome runs on), then UTF-8 JSON.
function reply(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

// Chrome starts this file and talks to it on stdin; a test only imports it for the functions above.
function listen() {
  let buf = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (n > MAX_MESSAGE) process.exit(1);
      if (buf.length < 4 + n) return;
      const text = buf.subarray(4, 4 + n).toString("utf8");
      buf = buf.subarray(4 + n);
      let out;
      try {
        out = handle(JSON.parse(text));
      } catch (e) {
        // The message only: a password is never part of an error here.
        out = { ok: false, error: String((e && e.message) || e).slice(0, 300) };
      }
      reply(out);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
if (/host\.mjs$/i.test(process.argv[1] || "")) listen();

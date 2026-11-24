/**
 * The pairing code the extension and the server share (see extension/PROTOCOL.md).
 *
 * The code is made once per machine and kept in a file only the user can read;
 * the user pastes it into the extension popup once. It never crosses the wire:
 * each side proves it holds it with an HMAC over two fresh nonces, so a web
 * page, another local process squatting on the port, or a second extension
 * without the code gets nowhere.
 */
import { createCipheriv, createDecipheriv, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

type Env = Record<string, string | undefined>;

/** Crockford's base32: no I, L, O, U, so a code read aloud or retyped survives. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 26 characters of 5 bits: 130 random bits. */
export const CODE_LENGTH = 26;

/** A new pairing code: 26 Crockford base32 characters from the system's cryptographic random source. */
export function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CROCKFORD[randomInt(32)];
  return code;
}

/** The code as people see it: groups of five, dashes between (cosmetic). */
export function formatCode(code: string): string {
  return normalizeCode(code).match(/.{1,5}/g)?.join("-") ?? "";
}

/** Uppercase, look-alikes mapped (I, L → 1; O → 0), everything outside [0-9A-Z] removed: what the HMAC key is made of. */
export function normalizeCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/[^0-9A-Z]/g, "");
}

/** Where the code is kept: the per-user config directory of each OS. */
export function pairingFile(platform: NodeJS.Platform = process.platform, env: Env = process.env, home: string = homedir()): string {
  if (platform === "win32") return win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), "sap-ui-automation", "extension-pairing");
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "sap-ui-automation", "extension-pairing");
  return posix.join(env.XDG_CONFIG_HOME || posix.join(home, ".config"), "sap-ui-automation", "extension-pairing");
}

export interface PairingCode {
  /** Normalized. */
  code: string;
  /** The file it lives in; undefined when SAP_EXTENSION_CODE set it. */
  file: string | undefined;
}

/**
 * The machine's pairing code: SAP_EXTENSION_CODE when set (tests, CI), else the
 * pairing file, made on first use with mode 0600 (and its directory 0700),
 * and set back to 0600 when it is found open to others. A
 * file whose content is not a code is replaced: no extension can be paired
 * with it anyway.
 */
export function readOrCreateCode(env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): PairingCode {
  const fromEnv = env.SAP_EXTENSION_CODE?.trim();
  if (fromEnv) {
    const code = normalizeCode(fromEnv);
    // A short code could be found offline from the MACs a fake relay collects: the extension refuses one too.
    if (code.length !== CODE_LENGTH) throw new Error(`SAP_EXTENSION_CODE must be a pairing code of ${CODE_LENGTH} letters and digits (got ${code.length}); \`sap-ui-automation extension pair\` makes one`);
    return { code, file: undefined };
  }
  const file = pairingFile(platform, env, home);
  try {
    const code = normalizeCode(readFileSync(file, "utf8"));
    if (code.length === CODE_LENGTH) {
      ownerOnly(file, platform);
      return { code, file };
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const code = generateCode();
  mkdirSync((platform === "win32" ? win32 : posix).dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${formatCode(code)}\n`, { mode: 0o600 });
  // The mode above applies to a new file only: one that was there keeps its own.
  ownerOnly(file, platform);
  return { code, file };
}

/**
 * On POSIX, makes the file readable by its owner only (0600) when it is open
 * to more: a pairing file copied in, or made by hand, is not trusted as it is.
 * Windows has no such modes: there the user's profile directory keeps others out.
 */
function ownerOnly(file: string, platform: NodeJS.Platform): void {
  if (platform === "win32" || process.platform === "win32") return;
  if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
}

/** Which side proves itself: the extension ("sap-gui-ext") or the server ("sap-gui-srv"). */
export type MacLabel = "sap-gui-ext" | "sap-gui-srv";

/** Base64 HMAC-SHA256 of `label|nS|nE`, keyed with the UTF-8 bytes of the normalized code. */
export function hmac(code: string, label: MacLabel, nS: string, nE: string): string {
  return createHmac("sha256", Buffer.from(normalizeCode(code), "utf8")).update(`${label}|${nS}|${nE}`, "utf8").digest("base64");
}

/** Compares two strings without leaking, through timing, how much of them matches. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The two directions of a paired connection, each with its own key and counter. */
export type KeyLabel = "sap-gui-key-s2e" | "sap-gui-key-e2s";

/** The 32-byte AES key of one direction: HMAC-SHA256 of `label|nS|nE`, keyed like the MACs. */
export function sessionKey(code: string, label: KeyLabel, nS: string, nE: string): Buffer {
  return createHmac("sha256", Buffer.from(normalizeCode(code), "utf8")).update(`${label}|${nS}|${nE}`, "utf8").digest();
}

/** AES-256-GCM IV of frame `n`: 4 zero bytes, then the counter as 8 bytes big-endian. */
function frameIv(n: bigint): Buffer {
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(n, 4);
  return iv;
}

/**
 * One direction of the encrypted channel after the handshake (see PROTOCOL.md):
 * every frame is AES-256-GCM with the IV taken from a counter both sides keep,
 * so a frame dropped, replayed, reordered or forged by a process in the middle
 * fails to open.
 */
export class FrameCipher {
  private n = 0n;
  constructor(private readonly key: Buffer) {}

  /** The next frame: ciphertext followed by the 16-byte tag, as WebCrypto lays it out. */
  seal(text: string): Buffer {
    const c = createCipheriv("aes-256-gcm", this.key, frameIv(this.n++));
    return Buffer.concat([c.update(text, "utf8"), c.final(), c.getAuthTag()]);
  }

  /** The text of the next frame; throws when it does not open. */
  open(frame: Buffer): string {
    if (frame.length < 16) throw new Error("frame too short");
    const d = createDecipheriv("aes-256-gcm", this.key, frameIv(this.n++));
    d.setAuthTag(frame.subarray(frame.length - 16));
    return Buffer.concat([d.update(frame.subarray(0, frame.length - 16)), d.final()]).toString("utf8");
  }
}

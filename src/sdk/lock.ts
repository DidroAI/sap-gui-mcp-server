/**
 * The lock file: what the screens looked like on a run of a `*.sap.ts` test
 * that passed (docs/cached-steps.md, "Lock files").
 *
 * The code is the source of truth for WHAT to do. The lock, a sidecar the
 * SDK writes (`<name>.sap.lock.json` next to `<name>.sap.ts`), holds what
 * SAP answered: for each test, for each `sap.step` block (by name, and its
 * ordinal when the block runs more than once), the actions in order with
 * the screen each one was done on and the screen and status bar it led to.
 * A run in verified mode (sdk/verify.ts) compares each action's landing
 * with it and stops on drift, with no model.
 *
 *   {
 *     "format": "sap-gui-lock/1",
 *     "tests": {
 *       "create order": {
 *         "verified": { "at": "...", "system": "ABA", "client": "800", "surface": "webgui", "runs": 3, "lastPass": "..." },
 *         "steps": [
 *           { "step": "Create Order: Initial Screen", "ordinal": 1,
 *             "paths": [[ { "action": {"do":"set","id":"ZORD-KUNNR","value":"2200"}, "risk": "navigate",
 *                           "after": {"transaction":"ZA01","program":"SAPMZA01","screen":"100"} }, ... ]],
 *             "repairs": [ { "index": 2, "on": "key:0", "place": "after", "actions": [...], "why": "...", "at": "..." } ] }
 *         ]
 *       }
 *     }
 *   }
 *
 * A step holds one path per way through it that has passed (a block with an
 * `if` has one per branch taken). `repairs` are overlays: repairs that
 * worked, applied by later runs only where the same drift shows again.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { NormalizedAction } from "../core/action.js";
import { vkeyNumber } from "../sapgui/keys.js";

export const LOCK_FORMAT = "sap-gui-lock/1";

const ref = z.object({
  transaction: z.string().optional(),
  program: z.string().optional(),
  screen: z.string().optional(),
  title: z.string().optional(),
  /** The popup window in front (wnd[1]...), when there was one. */
  popup: z.string().optional(),
});

const lockAction = z.object({
  /** The action as the code ran it (values as typed in that run). */
  action: z.record(z.string(), z.unknown()),
  /** The control it was done on, when the screen before it was read. */
  target: z.object({ id: z.string(), handle: z.string().optional(), type: z.string().optional(), label: z.string().optional() }).optional(),
  /** read, navigate or commit, as the surface rated it. */
  risk: z.string().optional(),
  /** The screen it was done on. */
  on: ref.optional(),
  /** The screen and status bar it led to. Only the status type is compared. */
  after: ref.extend({ status: z.object({ type: z.string().optional(), text: z.string() }).optional() }),
});

const lockRepair = z.object({
  /** The action of the step it is for (from 0), and that action's identity, as `identity()` writes it. */
  index: z.number().int().nonnegative(),
  on: z.string(),
  place: z.enum(["before", "instead", "after"]),
  actions: z.array(z.record(z.string(), z.unknown())).min(1),
  why: z.string(),
  at: z.string(),
});

const lockStep = z.object({
  /** The `sap.step` name (nested blocks joined with " › "); "" for actions outside any block. */
  step: z.string(),
  /** 1 for the first time a block of this name runs in the test, 2 for the second... */
  ordinal: z.number().int().positive(),
  paths: z.array(z.array(lockAction)),
  repairs: z.array(lockRepair).optional(),
});

const lockTest = z.object({
  verified: z.object({
    /** When this entry was first written. */
    at: z.string(),
    system: z.string().optional(),
    client: z.string().optional(),
    surface: z.string(),
    /** Passing runs that wrote or confirmed it. */
    runs: z.number().int().nonnegative(),
    lastPass: z.string(),
  }),
  steps: z.array(lockStep),
});

export const lockSchema = z.object({
  format: z.literal(LOCK_FORMAT),
  tests: z.record(z.string(), lockTest),
});

export type LockRef = z.infer<typeof ref>;
export type LockAction = z.infer<typeof lockAction>;
export type LockRepair = z.infer<typeof lockRepair>;
export type LockStep = z.infer<typeof lockStep>;
export type LockTest = z.infer<typeof lockTest>;
export type Lock = z.infer<typeof lockSchema>;

export const emptyLock = (): Lock => ({ format: LOCK_FORMAT, tests: {} });

export function parseLock(json: string, file = "lock"): Lock {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`${file}: not JSON: ${(e as Error).message}`);
  }
  const r = lockSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new Error(`${file}: not a ${LOCK_FORMAT} file: ${i ? `${i.path.join(".") || "(root)"}: ${i.message}` : "invalid"}`);
  }
  return r.data;
}

/** The lock at `file`, or undefined when there is none. */
export async function readLock(file: string): Promise<Lock | undefined> {
  const text = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  return text === undefined ? undefined : parseLock(text, file);
}

export const serializeLock = (l: Lock): string => `${JSON.stringify(l, null, 2)}\n`;

/**
 * Writes one test's entry: the file is read again first, so the entries of
 * other tests written meanwhile are kept; tmp + rename, so it is never torn.
 */
export async function writeLockEntry(file: string, key: string, entry: LockTest): Promise<void> {
  const lock = (await readLock(file).catch(() => undefined)) ?? emptyLock();
  lock.tests[key] = entry;
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, serializeLock(lock), "utf8");
  await rename(tmp, file);
}

/** `orders.sap.ts` -> `orders.sap.lock.json`; any other file `x.ts` -> `x.lock.json`. */
export function lockPathFor(file: string): string {
  if (/\.sap\.[mc]?[jt]s$/.test(file)) return file.replace(/\.sap\.[mc]?[jt]s$/, ".sap.lock.json");
  if (/\.[mc]?[jt]s$/.test(file)) return file.replace(/\.[mc]?[jt]s$/, ".lock.json");
  return `${file}.lock.json`;
}

/**
 * What makes two actions the same action of a step: the verb and the
 * control, the key, the row; for an okcode the command. Not a typed value:
 * data may differ from run to run, the screen it leads to may not.
 */
export function identity(a: NormalizedAction | Record<string, unknown>): string {
  const parts: string[] = [String(a.do)];
  if (a.do === "okcode") parts.push(String(a.value ?? "").trim().toUpperCase());
  if (a.do === "open") parts.push(String(a.app ?? ""));
  if (a.id !== undefined) parts.push(String(a.id));
  if (a.do === "key") parts.push(String(vkeyNumber(a.key ?? a.value) ?? a.key));
  if (a.do === "combo") parts.push(String(a.key ?? ""));
  for (const k of ["row", "col", "node", "how"] as const) if (a[k] !== undefined) parts.push(`${k}=${String(a[k])}`);
  return parts.join(":");
}

/** "ZA01 SAPMZA01/200 (popup wnd[1])" */
export function refText(r: LockRef | undefined): string {
  if (!r) return "(unknown screen)";
  return `${r.transaction ?? "?"} ${r.program ?? "?"}/${r.screen ?? "?"}${r.popup ? ` (popup ${r.popup})` : ""}${r.title ? ` "${r.title}"` : ""}`;
}

/** Does the screen now stand where the lock says the action led? Program, dynpro, transaction strict where both have them; a popup or none; the title is not compared. */
export function sameLanding(expected: LockRef, actual: LockRef): boolean {
  const moved = (["transaction", "program", "screen"] as const).some((k) => expected[k] && actual[k] && expected[k] !== actual[k]);
  return !moved && !!expected.popup === !!actual.popup;
}

/** A new error or abort in the status bar: E or A, unless the lock has the same type there. */
export function newError(expected: LockAction["after"], actualType: string | undefined): boolean {
  return (actualType === "E" || actualType === "A") && expected.status?.type !== actualType;
}

/** Are two paths the same way through a step: the same actions leading to the same screens? */
export function samePath(a: LockAction[], b: LockAction[]): boolean {
  return a.length === b.length && a.every((x, i) => {
    const y = b[i] as LockAction;
    const err = (t: string | undefined) => (t === "E" || t === "A" ? t : "");
    return identity(x.action) === identity(y.action) && sameLanding(x.after, y.after) && sameLanding(y.after, x.after) && err(x.after.status?.type) === err(y.after.status?.type);
  });
}

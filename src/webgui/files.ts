/**
 * Files SAP hands to "the local machine" in Web GUI, and where they end up.
 *
 * A person exports a list with List > Export > Local File (or "%PC"), gives
 * a file name, and SAP answers "Download 16 KB ... /Z/name.txt". In SAP GUI
 * for HTML that file is not written to a disk: Web GUI keeps it in its own
 * file store inside the browser (an IndexedDB database named
 * `filesystem_<origin>_temporary`, one record per file and its content as a
 * Blob under `BLOB_ID_<n>`; seen on ECC, kernel 7.5x), from where a person
 * downloads it with the "SAP GUI for HTML File Browser". An agent has no
 * such step, so SAP's success message was a file nobody could read.
 *
 * After each action the server therefore looks at that store, copies a file
 * that is new or has changed to SAP_DOWNLOAD_DIR, and says so in the
 * action's answer. A real browser download (the File Browser's own
 * "download", a PDF) is saved to the same directory. When a copy fails, the
 * answer says that the file did not reach this machine.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { Download, Page } from "playwright-core";
import { within } from "../browser/tab.js";
import type { WebGuiSession } from "./session.js";

type Env = Record<string, string | undefined>;

/** Where copied files go: SAP_DOWNLOAD_DIR, else `downloads` in the recordings directory, else ./sap-downloads. */
export function downloadDir(env: Env = process.env, cwd: string = process.cwd()): string {
  if (env.SAP_DOWNLOAD_DIR) return resolve(cwd, env.SAP_DOWNLOAD_DIR);
  if (env.SAP_RECORD_DIR) return resolve(cwd, env.SAP_RECORD_DIR, "downloads");
  return join(cwd, "sap-downloads");
}

/** A file larger than this is not copied: its content crosses from the page to the server in one piece. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** One file of Web GUI's file store. */
export interface StoredFile {
  db: string;
  /** Its path in the store ("/mid.txt"). */
  path: string;
  size: number;
  modified: string;
  blobId: string;
}

/** Runs in the page: the files of Web GUI's file store. Empty when the page has none (no export yet, another Web GUI). */
export const listStoredFiles = async (): Promise<StoredFile[]> => {
  const out: StoredFile[] = [];
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return out;
  for (const d of await indexedDB.databases()) {
    const name = d.name ?? "";
    if (!/^filesystem_/.test(name)) continue;
    const db = await new Promise<IDBDatabase | undefined>((res) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(undefined);
      r.onblocked = () => res(undefined);
    });
    if (!db) continue;
    try {
      if (!db.objectStoreNames.contains("items")) continue;
      const values = await new Promise<unknown[]>((res) => {
        const r = db.transaction("items").objectStore("items").getAll();
        r.onsuccess = () => res(r.result as unknown[]);
        r.onerror = () => res([]);
      });
      for (const v of values) {
        if (!v || typeof v !== "object" || v instanceof Blob) continue;
        const e = v as Record<string, unknown>;
        if (String(e.isFile) !== "true" || typeof e.fullPath !== "string" || e.blobId === undefined) continue;
        out.push({ db: name, path: e.fullPath, size: Number(e.size) || 0, modified: String(e.lastModifiedDate ?? "").replace(/"/g, ""), blobId: String(e.blobId) });
      }
    } finally {
      db.close();
    }
  }
  return out;
};

/** Runs in the page: the content of one stored file, base64, or why it cannot be given. */
export const readStoredFile = async (arg: { db: string; blobId: string; max: number }): Promise<{ base64: string; size: number } | { error: string }> => {
  const db = await new Promise<IDBDatabase | undefined>((res) => {
    const r = indexedDB.open(arg.db);
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(undefined);
    r.onblocked = () => res(undefined);
  });
  if (!db) return { error: "Web GUI's file store could not be opened" };
  try {
    const store = () => db.transaction("items").objectStore("items");
    const keys = await new Promise<IDBValidKey[]>((res) => {
      const r = store().getAllKeys();
      r.onsuccess = () => res(r.result);
      r.onerror = () => res([]);
    });
    // The content is one Blob under BLOB_ID_<n>; a file in several parts keeps them under keys that start the same.
    const mine = keys
      .filter((k): k is string => typeof k === "string" && (k === `BLOB_ID_${arg.blobId}` || k.startsWith(`BLOB_ID_${arg.blobId}_`)))
      .sort((x, y) => x.length - y.length || (x < y ? -1 : 1));
    if (!mine.length) return { error: "its content is not in Web GUI's file store" };
    const parts: Blob[] = [];
    for (const k of mine) {
      const v = await new Promise<unknown>((res) => {
        const r = store().get(k);
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(undefined);
      });
      if (v instanceof Blob) parts.push(v);
      else if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) parts.push(new Blob([v as ArrayBuffer]));
      else if (typeof v === "string") parts.push(new Blob([v]));
      else return { error: "its content is stored in a form the server does not know" };
    }
    const whole = new Blob(parts);
    if (whole.size > arg.max) return { error: `it is ${whole.size} bytes, more than the ${arg.max} the server copies` };
    const bytes = new Uint8Array(await whole.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { base64: btoa(bin), size: whole.size };
  } finally {
    db.close();
  }
};

/** A file name that stays inside the directory: the store's path without its leading slash, each part cleaned. */
export function localName(path: string): string {
  const parts = path
    .split(/[\\/]+/)
    .map((p) => p.replace(/[^\p{L}\p{N}._ ()+-]/gu, "_").replace(/^\.+/, "_"))
    .filter(Boolean);
  return parts.join("_") || "file";
}

interface Watch {
  /** The files seen so far, by store and path: what a later look compares with. Undefined until the first look. */
  seen: Map<string, string> | undefined;
  /** Browser downloads under way or done, with where each was saved and the line to say about it. */
  downloads: Promise<Saved>[];
}
const watches = new WeakMap<Page, Watch>();

interface Saved {
  target: string;
  /** The name the browser gave the file, as `localName` makes it. */
  name: string;
  line: string;
}

const stamp = (f: StoredFile) => `${f.blobId}|${f.size}|${f.modified}`;

/** Paths handed out by `freeTarget` whose file is being written: not on disk yet, and not free. */
const taken = new Set<string>();

/**
 * Where a file of this name goes in `dir`: the name itself, else the first of
 * "name (2).ext", "name (3).ext", ... that is neither on disk nor handed out
 * already. A second "export.xlsx" must not replace the first.
 */
export function freeTarget(dir: string, name: string): string {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; ; n++) {
    const target = join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    if (taken.has(target) || existsSync(target)) continue;
    taken.add(target);
    return target;
  }
}

/** What the answer adds when the file was saved under another name than its own: why. */
const renamed = (target: string, name: string) => (basename(target) === name ? "" : ` (a file "${name}" was there already)`);

async function saveDownload(d: Download, dir: string): Promise<Saved> {
  const suggested = d.suggestedFilename() || "download";
  const name = localName(suggested);
  try {
    await mkdir(dir, { recursive: true });
    const target = freeTarget(dir, name);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error("the browser did not hand the file over within 30 s")), 30_000);
    });
    await Promise.race([d.saveAs(target), late]).finally(() => {
      clearTimeout(timer);
      taken.delete(target);
    });
    return { target, name, line: `The browser downloaded a file, "${suggested}": saved as ${target}${renamed(target, name)}.` };
  } catch (e) {
    return { target: "", name, line: `The browser downloaded a file, "${suggested}", but the server could not save it (${(e as Error).message.split("\n")[0]}): it did not reach this machine, or it is in the browser's own download folder.` };
  }
}

function watchOf(page: Page, dir: string): Watch {
  let w = watches.get(page);
  if (!w) {
    const watch: Watch = { seen: undefined, downloads: [] };
    w = watch;
    page.on("download", (d) => {
      watch.downloads.push(saveDownload(d, dir));
    });
    watches.set(page, w);
  }
  return w;
}

/** Starts watching a tab: what its file store holds now is not news later. Called before an action runs. */
export async function watchFiles(session: WebGuiSession, env: Env = process.env): Promise<void> {
  const w = watchOf(session.page, downloadDir(env));
  if (w.seen) return;
  const now = await session.frame.evaluate(listStoredFiles).catch(() => undefined);
  if (now) w.seen = new Map(now.map((f) => [`${f.db}|${f.path}`, stamp(f)]));
}

/**
 * After an action: the lines to add to its answer for every file SAP wrote
 * since the last look (copied out of Web GUI's file store) and every browser
 * download that finished. No line when there is none.
 */
export async function collectFiles(session: WebGuiSession, env: Env = process.env): Promise<string[]> {
  const dir = downloadDir(env);
  const w = watchOf(session.page, dir);
  const lines: string[] = [];
  // A browser download that started with this action is given a moment to finish. Looked at first: Web GUI
  // can hand the same file to the browser as a download too, and then it is saved once, under one line.
  const downloaded = new Map<string, Saved>();
  if (w.downloads.length) {
    const pending = w.downloads.splice(0);
    const done = await Promise.all(pending.map((p) => within<Saved | undefined>(p, 5000, undefined)));
    done.forEach((saved, i) => {
      if (!saved) w.downloads.push(pending[i] as Promise<Saved>);
      else if (saved.target) downloaded.set(saved.name, saved);
      else lines.push(saved.line);
    });
  }
  const now = await session.frame.evaluate(listStoredFiles).catch(() => undefined);
  if (now) {
    const before = w.seen;
    w.seen = new Map(now.map((f) => [`${f.db}|${f.path}`, stamp(f)]));
    // Without a look before the action nothing can be called new.
    for (const f of before ? now : []) {
      if (before?.get(`${f.db}|${f.path}`) === stamp(f)) continue;
      const what = `SAP wrote the file "${f.path.replace(/^\//, "")}" (${f.size} bytes). Web GUI keeps such a file in its own store inside the browser, not on a disk`;
      const name = localName(f.path);
      const same = downloaded.get(name);
      if (same) {
        downloaded.delete(name);
        lines.push(`${what}: the server copied it to ${same.target}${renamed(same.target, name)}.`);
        continue;
      }
      try {
        if (!resolve(join(dir, name)).startsWith(resolve(dir) + sep)) throw new Error("its name leads outside the download directory");
        const got = await session.frame.evaluate(readStoredFile, { db: f.db, blobId: f.blobId, max: MAX_FILE_BYTES });
        if ("error" in got) throw new Error(got.error);
        await mkdir(dir, { recursive: true });
        const target = freeTarget(dir, name);
        await writeFile(target, Buffer.from(got.base64, "base64")).finally(() => taken.delete(target));
        lines.push(`${what}: the server copied it to ${target}${renamed(target, name)}.`);
      } catch (e) {
        lines.push(`${what}, and the server could not copy it out (${(e as Error).message.split("\n")[0]}): the file did not reach this machine. Read the data from the screen instead (sap_look with "id" and "rows").`);
      }
    }
  }
  for (const saved of downloaded.values()) lines.push(saved.line);
  return lines;
}

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { collectFiles, downloadDir, listStoredFiles, localName, readStoredFile, type StoredFile, watchFiles } from "../src/webgui/files.js";
import type { WebGuiSession } from "../src/webgui/session.js";

/** A tab whose file store holds `files`; `content` is what reading one gives. */
function fakeSession(files: StoredFile[], content: (f: { blobId: string }) => { base64: string; size: number } | { error: string }) {
  const handlers: Record<string, (x: unknown) => void> = {};
  const state = { files, lists: 0, reads: 0 };
  const session = {
    page: { on: (name: string, f: (x: unknown) => void) => void (handlers[name] = f) },
    frame: {
      evaluate: async (fn: unknown, arg?: { blobId: string }) => {
        if (fn === listStoredFiles) {
          state.lists++;
          return state.files;
        }
        if (fn === readStoredFile) {
          state.reads++;
          return content(arg as { blobId: string });
        }
        throw new Error("unexpected script");
      },
    },
  } as unknown as WebGuiSession;
  return { session, state, handlers };
}

const file = (path: string, blobId: string, size: number, modified = "2026-01-01T00:00:00.000Z"): StoredFile => ({ db: "filesystem_http_host:8000_temporary", path, size, modified, blobId });
const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("files SAP writes to the local machine in Web GUI", () => {
  test("a file that appears with an action is copied out and named in the answer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sapdl-"));
    const env = { SAP_DOWNLOAD_DIR: dir };
    const { session, state, handlers } = fakeSession([], () => ({ base64: b64("a\tb\n"), size: 4 }));
    await watchFiles(session, env);
    expect(await collectFiles(session, env)).toEqual([]);
    state.files = [file("/list.txt", "1", 4)];
    expect(await collectFiles(session, env)).toEqual([
      `SAP wrote the file "list.txt" (4 bytes). Web GUI keeps such a file in its own store inside the browser, not on a disk: the server copied it to ${join(dir, "list.txt")}.`,
    ]);
    expect(await readFile(join(dir, "list.txt"), "utf8")).toBe("a\tb\n");
    // Web GUI may hand the same file to the browser as a download as well: still one line.
    state.files = [file("/list.txt", "1", 4), file("/two.txt", "5", 4)];
    handlers.download?.({ suggestedFilename: () => "two.txt", saveAs: async () => {} });
    const both = await collectFiles(session, env);
    expect(both.length).toBe(1);
    expect(both[0]).toContain(`the server copied it to ${join(dir, "two.txt")}.`);
    state.files = [file("/list.txt", "1", 4)];
    await collectFiles(session, env);
    // The same file is not news again; replaced (new content id), it is.
    expect(await collectFiles(session, env)).toEqual([]);
    state.files = [file("/list.txt", "2", 9)];
    expect((await collectFiles(session, env)).length).toBe(1);
  });

  test("a file that was there before the first action is not announced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sapdl-"));
    const env = { SAP_DOWNLOAD_DIR: dir };
    const { session, state } = fakeSession([file("/old.txt", "1", 3)], () => ({ base64: b64("old"), size: 3 }));
    await watchFiles(session, env);
    expect(await collectFiles(session, env)).toEqual([]);
    expect(state.reads).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  });

  test("a file that cannot be copied is said not to have reached this machine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sapdl-"));
    const env = { SAP_DOWNLOAD_DIR: dir };
    const { session, state } = fakeSession([], () => ({ error: "it is 99 bytes, more than the 10 the server copies" }));
    await watchFiles(session, env);
    state.files = [file("/big.txt", "1", 99)];
    const [line] = await collectFiles(session, env);
    expect(line).toContain("the server could not copy it out (it is 99 bytes, more than the 10 the server copies): the file did not reach this machine.");
    expect(await readdir(dir)).toEqual([]);
  });

  test("a page without the file store costs nothing and says nothing", async () => {
    const { session } = fakeSession([], () => ({ error: "none" }));
    (session.frame as unknown as { evaluate: () => Promise<never> }).evaluate = async () => {
      throw new Error("Execution context was destroyed");
    };
    await watchFiles(session, {});
    expect(await collectFiles(session, {})).toEqual([]);
  });

  test("a browser download is saved to the same directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sapdl-"));
    const env = { SAP_DOWNLOAD_DIR: dir };
    const { session, handlers } = fakeSession([], () => ({ error: "none" }));
    await watchFiles(session, env);
    const saved: string[] = [];
    handlers.download?.({ suggestedFilename: () => "report 1.pdf", saveAs: async (p: string) => void saved.push(p) });
    expect(await collectFiles(session, env)).toEqual([`The browser downloaded a file, "report 1.pdf": saved as ${join(dir, "report 1.pdf")}.`]);
    expect(saved).toEqual([join(dir, "report 1.pdf")]);
    handlers.download?.({
      suggestedFilename: () => "x.pdf",
      saveAs: async () => {
        throw new Error("canceled");
      },
    });
    expect((await collectFiles(session, env))[0]).toContain("the server could not save it (canceled)");
  });

  test("names stay inside the directory", () => {
    expect(localName("/mid.txt")).toBe("mid.txt");
    expect(localName("/a/b c.txt")).toBe("a_b c.txt");
    for (const bad of ["/../../etc/passwd", "..\\x", "/a/../b"]) expect(localName(bad)).not.toMatch(/[\\/]|\.\./);
    expect(localName("/")).toBe("file");
  });

  test("the directory: SAP_DOWNLOAD_DIR, else downloads in the recordings directory, else ./sap-downloads", () => {
    expect(downloadDir({ SAP_DOWNLOAD_DIR: "/data/out" }, "/w")).toBe(resolve("/data/out"));
    expect(downloadDir({ SAP_RECORD_DIR: "/srv/sap-tests" }, "/w")).toBe(resolve("/srv/sap-tests", "downloads"));
    expect(downloadDir({}, "/w")).toBe(join("/w", "sap-downloads"));
  });
});

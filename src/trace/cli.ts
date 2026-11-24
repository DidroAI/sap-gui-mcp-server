/**
 *   sap-ui-automation show-trace <file.saptest.json> [--out file.html] [--open]
 *
 * Writes the trace page next to the file (`<name>.html`) or where --out
 * says, prints its path, and with --open shows it in the default browser.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseTest } from "../record/format.js";
import { renderTraceHtml } from "./html.js";

export const TRACE_HELP = `  sap-ui-automation show-trace <file> [--out <file.html>] [--open]
                                write a recorded test or trace as one HTML page (steps, timings, screens, screenshots)`;

/** The page's path for a test file: `x.saptest.json` -> `x.html`. */
export const htmlPathFor = (file: string): string => `${file.replace(/\.saptest\.json$|\.json$/i, "")}.html`;

/** Opens a file in the default browser, without waiting for it. */
export function openInBrowser(path: string, platform: NodeJS.Platform = process.platform): void {
  const [cmd, args] = platform === "darwin" ? ["open", [path]] : platform === "win32" ? ["cmd", ["/c", "start", "", path]] : ["xdg-open", [path]];
  const child = spawn(cmd, args as string[], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", (e) => console.error(`Could not open a browser (${e.message}); open ${path} yourself.`));
  child.unref();
}

export async function showTraceCommand(argv: string[], open: (path: string) => void = openInBrowser): Promise<number> {
  let out: string | undefined;
  let doOpen = false;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--out") {
      out = argv[++i];
      if (!out) return console.error("--out needs a file name."), 2;
    } else if (a === "--open") doOpen = true;
    else if (a.startsWith("--")) return console.error(`Unknown option ${a}.\n${TRACE_HELP}`), 2;
    else files.push(a);
  }
  const file = files[0];
  if (!file || files.length > 1) return console.error(`Give one test or trace file.\n${TRACE_HELP}`), 2;
  let html: string;
  try {
    const test = parseTest(await readFile(file, "utf8"));
    html = await renderTraceHtml(test, { baseDir: dirname(resolve(file)) });
  } catch (e) {
    console.error(`${file}: ${(e as Error).message}`);
    return 1;
  }
  const path = resolve(out ?? htmlPathFor(file));
  await writeFile(path, html);
  console.log(path);
  if (doOpen) open(path);
  return 0;
}

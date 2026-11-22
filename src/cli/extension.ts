/**
 *   sap-gui-mcp-server extension unpack [dir]   copies the Chrome extension to a folder Chrome can load
 *   sap-gui-mcp-server extension pair           prints the pairing code to paste into the extension
 *
 * Until the extension is in the Chrome Web Store, it is loaded unpacked from a
 * folder. The package's own copy lives in npm's cache, which npx may clear, so
 * `unpack` copies it to a stable place first (default ~/sap-gui-mcp-extension,
 * a folder Chrome's file dialog shows on every system).
 */
import { cpSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXTENSION_HELP = `  sap-gui-mcp-server extension unpack [dir]
                                copy the Chrome extension to dir (default ~/sap-gui-mcp-extension) to load it
                                in chrome://extensions > Load unpacked
  sap-gui-mcp-server extension pair
                                print the code to paste into the extension's popup (SAP_BROWSER=extension)`;

/** The extension folder shipped with the package: <package>/extension, from src/cli or dist/cli alike. */
export function bundledExtensionDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "extension");
}

export async function extensionCommand(args: string[], out: (l: string) => void = console.log, err: (l: string) => void = console.error): Promise<number> {
  const sub = args[0];
  if (sub === "pair") {
    const { extensionPairCommand } = await import("../browser/extension/index.js");
    for (const l of await extensionPairCommand()) out(l);
    return 0;
  }
  if (sub === "unpack") {
    const from = bundledExtensionDir();
    if (!existsSync(join(from, "manifest.json"))) {
      err(`The extension is not in this package (looked in ${from}).`);
      return 1;
    }
    const to = resolve(args[1] ?? join(homedir(), "sap-gui-mcp-extension"));
    cpSync(from, to, { recursive: true, filter: (p) => !/\.md$/i.test(p) || p.endsWith("README.md") });
    out(`Copied the extension to ${to}`);
    out(`In Chrome: open chrome://extensions, turn on Developer mode, click "Load unpacked" and pick that folder.`);
    out(`Then run "sap-gui-mcp-server extension pair" and paste the code into the extension's popup.`);
    out(`After an update of sap-gui-mcp-server, run unpack again and click the reload arrow on the extension's card.`);
    return 0;
  }
  err(`Usage:\n${EXTENSION_HELP}`);
  return 2;
}

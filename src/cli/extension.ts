/**
 *   sap-gui-mcp-server extension install [dir]  copies the Chrome extension to a folder Chrome can load, and
 *                                               installs its helper (pairing in one click, passwords in the keychain)
 *   sap-gui-mcp-server extension pair           prints the pairing code, for pairing by hand
 *
 * Until the extension is in the Chrome Web Store, it is loaded unpacked from a
 * folder. The package's own copy lives in npm's cache, which npx may clear, so
 * `install` copies it to a stable place first (default ~/sap-gui-mcp-extension,
 * a folder Chrome's file dialog shows on every system). `unpack` is the same.
 */
import { cpSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXTENSION_HELP = `  sap-gui-mcp-server extension install [dir]
                                copy the Chrome extension to dir (default ~/sap-gui-mcp-extension) to load it
                                in chrome://extensions > Load unpacked, and install its helper: the extension
                                then pairs in one click and keeps saved SAP passwords in the keychain
  sap-gui-mcp-server extension pair
                                print the pairing code, to pair the extension by hand (SAP_BROWSER=extension)`;

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
  if (sub === "install" || sub === "unpack") {
    const from = bundledExtensionDir();
    if (!existsSync(join(from, "manifest.json"))) {
      err(`The extension is not in this package (looked in ${from}).`);
      return 1;
    }
    const to = resolve(args[1] ?? join(homedir(), "sap-gui-mcp-extension"));
    cpSync(from, to, { recursive: true, filter: (p) => !/\.md$/i.test(p) || p.endsWith("README.md") });
    out(`Copied the extension to ${to}`);
    const { installNativeHost } = await import("../browser/extension/native.js");
    let paired = false;
    try {
      const host = installNativeHost();
      paired = host.registered.length > 0;
      out(paired ? `Installed its helper in ${host.hostDir} (for ${host.registered.length} browser profile folder(s)).` : `Copied its helper to ${host.hostDir}, but no browser took it: pair by hand (see below).`);
    } catch (e) {
      err(`Could not install the helper: ${(e as Error).message}. Pair by hand (see below).`);
    }
    out("");
    out(`In Chrome: open chrome://extensions, turn on Developer mode, click "Load unpacked" and pick ${to}.`);
    out(paired ? `Then click the extension's icon and "Pair with this computer".` : `Then run "sap-gui-mcp-server extension pair" and paste the code into the extension's popup.`);
    out(`After an update of sap-gui-mcp-server, run install again and click the reload arrow on the extension's card.`);
    return 0;
  }
  err(`Usage:\n${EXTENSION_HELP}`);
  return 2;
}

#!/usr/bin/env node
/**
 *   sap-gui-mcp-server            the stdio MCP server (default)
 *   sap-gui-mcp-server doctor     checks what the server can reach on this machine
 *   sap-gui-mcp-server sessions   lists the SAP sessions it finds, then exits
 */
import { disconnectChrome } from "./browser/chrome.js";
import { policyFromEnv } from "./core/guard.js";
import { Registry } from "./core/registry.js";
import { SERVER_VERSION, sessionLine } from "./server.js";
import { serveStdio } from "./stdio.js";
import { surfacesFromEnv } from "./surfaces.js";

const HELP = `sap-gui-mcp-server ${SERVER_VERSION}: an MCP server that sees and drives SAP screens you have open.

Usage:
  sap-gui-mcp-server            start the stdio server (what MCP clients run)
  sap-gui-mcp-server doctor     check SAP GUI scripting and Chrome access on this machine
  sap-gui-mcp-server sessions   list the SAP sessions found now
  sap-gui-mcp-server --version | --help

Environment:
  SAP_WRITE=off|confirm|on      actions that may write to SAP: refused (default), confirmed by the user, or allowed
  SAP_ALLOW_SYSTEMS=ABA/800,S4H only these systems (and clients)
  SAP_ALLOW_TCODES / SAP_BLOCK_TCODES   transactions the agent may / may not open or work in
  SAP_ALLOW_ORIGINS=https://myhost:44300  only browser tabs of these origins (comma list)
  SAP_SURFACES=sapgui,webgui,fiori      which kinds of session to look for
  SAP_CHROME_CDP=http://127.0.0.1:9222  a Chrome DevTools endpoint to attach to. Default: the running Chrome or Edge
                                        that allows remote debugging (chrome://inspect/#remote-debugging). A Chrome
                                        started with --remote-debugging-port is used only when named here; Chrome 136+
                                        opens that port only together with --user-data-dir.
  SAP_VIEW=diff|full                    what an action answers with: only what changed when the screen is the same (default),
                                        or always the whole screen
  SAP_FIORI_WAIT=busy                   faster Fiori waits (busy indicators only, skips UI5 RecordReplay)`;

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (cmd === "--version" || cmd === "-v") return console.log(SERVER_VERSION), 0;
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return console.log(HELP), 0;
  if (!cmd) return await serveStdio(), -1;
  const surfaces = surfacesFromEnv();
  if (cmd === "doctor") {
    let ok = true;
    for (const s of surfaces)
      for (const c of await s.doctor()) {
        ok &&= c.ok;
        console.log(`${c.ok ? "ok  " : "FAIL"} ${s.name.padEnd(7)} ${c.check}: ${c.detail}`);
      }
    return ok ? 0 : 1;
  }
  if (cmd === "sessions") {
    const r = new Registry(surfaces, policyFromEnv());
    const { sessions, hidden, errors, allFailed } = await r.discover();
    sessions.forEach((s, i) => console.log(sessionLine(s, i, false)));
    if (hidden) console.log(`${hidden} session(s) of systems outside SAP_ALLOW_SYSTEMS are hidden.`);
    for (const e of errors) console.error(e);
    if (!sessions.length) console.log("No SAP session found.");
    await r.closeAll();
    await disconnectChrome().catch(() => {});
    // Every surface failed: that is a setup problem, not "nothing open".
    return allFailed ? 1 : 0;
  }
  console.error(`Unknown command "${cmd}".\n\n${HELP}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e: unknown) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);

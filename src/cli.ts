#!/usr/bin/env node
/**
 *   sap-gui-mcp-server            the stdio MCP server (default)
 *   sap-gui-mcp-server setup      adds the server to Claude Code, Codex, Claude Desktop, Cursor, Windsurf and VS Code
 *   sap-gui-mcp-server init       sets a project up: sap.config.ts, an example test, skills, MCP clients
 *   sap-gui-mcp-server install --skills   copies the bundled agent skills into a project (or --global)
 *   sap-gui-mcp-server doctor     checks what the server can reach on this machine
 *   sap-gui-mcp-server sessions   lists the SAP sessions it finds, then exits
 *   sap-gui-mcp-server test       runs *.sap.ts tests (src/runner)
 */
import { disconnectChrome } from "./browser/chrome.js";
import { AGENT_COMMANDS, AGENT_HELP, agentCommand, daemonRunning } from "./cli/agent.js";
import { doctorReport } from "./cli/doctor.js";
import { init } from "./cli/init.js";
import { setup } from "./cli/setup.js";
import { installSkills, SKILL_TARGETS, type SkillTarget } from "./cli/skills.js";
import { policyFromEnv } from "./core/guard.js";
import { Registry } from "./core/registry.js";
import { exportCommand, RECORD_HELP, replayCommand } from "./record/cli.js";
import { TEST_HELP, testCommand } from "./runner/cli.js";
import { SERVER_VERSION, sessionLine } from "./server.js";
import { serveStdio } from "./stdio.js";
import { showTraceCommand, TRACE_HELP } from "./trace/cli.js";
import { surfacesFromEnv } from "./surfaces.js";

const HELP = `sap-gui-mcp-server ${SERVER_VERSION}: an MCP server that sees and drives SAP screens you have open.

Usage:
  sap-gui-mcp-server            start the stdio server (what MCP clients run)
  sap-gui-mcp-server setup [claude-code|codex|claude-desktop|cursor|windsurf|vscode] [--dry-run]
                                add the server to the MCP clients found on this machine
  sap-gui-mcp-server init [--yes] [--force] [--dry-run]
                                set this project up: sap.config.ts, sap-tests/example.sap.ts, agent skills,
                                MCP clients, .gitignore (asks a few questions; --yes takes the defaults)
  sap-gui-mcp-server install --skills [--target claude|codex|cursor|all] [--global] [--dry-run]
                                copy the bundled agent skills to .claude/skills, .agents/skills, .cursor/rules
                                (--global: ~/.claude/skills, ~/.codex/skills)
  sap-gui-mcp-server doctor     check SAP GUI scripting and Chrome access on this machine
  sap-gui-mcp-server sessions   list the SAP sessions found now
${RECORD_HELP}
${TRACE_HELP}
${TEST_HELP}
  sap-gui-mcp-server --version | --help

${AGENT_HELP}

Environment:
  SAP_WRITE=off|confirm|on      actions that may write to SAP: refused (default), confirmed by the user in the client
                                (MCP elicitation; refused where the client cannot ask), or allowed
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
  SAP_FIORI_WAIT=busy                   faster Fiori waits (busy indicators only, skips UI5 RecordReplay)
  SAP_RECORD_DIR=./sap-tests            where sap_record writes recordings and exports (default: sap-tests in the working directory)
  SAP_DOWNLOAD_DIR=./sap-downloads     Web GUI: where a file SAP exports "to a local file" is copied (default: downloads in SAP_RECORD_DIR when set)
  SAP_RECORD=on                         record every session from its first action, without sap_record start`;

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (cmd === "--version" || cmd === "-v") return console.log(SERVER_VERSION), 0;
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return console.log(HELP), 0;
  if (!cmd) return await serveStdio(), -1;
  if (cmd === "export") return exportCommand(argv.slice(1));
  if (cmd === "show-trace") return showTraceCommand(argv.slice(1));
  if (cmd === "init") return await initCommand(argv.slice(1));
  if (cmd === "install") return installCommand(argv.slice(1));
  if (cmd === "test") return testCommand(argv.slice(1));
  const agent = { env: process.env, cwd: process.cwd(), out: (l: string) => console.log(l), err: (l: string) => console.error(l) };
  if (AGENT_COMMANDS.has(cmd)) return agentCommand(argv, agent);
  // With a daemon running, the agent CLI's list: the same numbers, and * on its active session.
  if (cmd === "sessions" && (await daemonRunning(agent))) return agentCommand(argv, agent);
  const surfaces = surfacesFromEnv();
  if (cmd === "doctor") {
    if (surfaces.some((s) => s.name !== "sapgui")) console.error("Checking… (if Chrome asks whether to allow remote debugging, click Allow)\n");
    const report = await doctorReport(surfaces, SERVER_VERSION);
    console.log(report.text);
    return report.ok ? 0 : 1;
  }
  if (cmd === "setup") {
    const only = argv.slice(1).filter((a) => !a.startsWith("--"));
    const r = setup({ dryRun: argv.includes("--dry-run"), only });
    console.log(r.lines.join("\n"));
    return 0;
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
  if (cmd === "replay") {
    try {
      return await replayCommand(argv.slice(1), surfaces, policyFromEnv());
    } finally {
      await disconnectChrome().catch(() => {});
    }
  }
  console.error(`Unknown command "${cmd}".\n\n${HELP}`);
  return 2;
}

async function initCommand(args: string[]): Promise<number> {
  const yes = args.includes("--yes") || args.includes("-y") || !process.stdin.isTTY;
  let ask: ((q: string) => Promise<string>) | undefined;
  let rl: import("node:readline/promises").Interface | undefined;
  if (!yes) {
    const { createInterface } = await import("node:readline/promises");
    rl = createInterface({ input: process.stdin, output: process.stdout });
    ask = (q) => rl!.question(q);
  }
  try {
    const r = await init({ yes, force: args.includes("--force"), dryRun: args.includes("--dry-run"), ask });
    console.log(r.lines.join("\n"));
    return 0;
  } finally {
    rl?.close();
  }
}

function installCommand(args: string[]): number {
  if (!args.includes("--skills")) {
    console.error("Usage: sap-gui-mcp-server install --skills [--target claude|codex|cursor|all] [--global] [--dry-run]");
    return 2;
  }
  const i = args.indexOf("--target");
  const raw = (i >= 0 ? args[i + 1] : args.find((a) => a.startsWith("--target="))?.slice(9)) ?? "claude";
  const targets = raw === "all" ? [...SKILL_TARGETS] : raw.split(",").filter((t): t is SkillTarget => (SKILL_TARGETS as readonly string[]).includes(t));
  if (!targets.length) {
    console.error(`Unknown --target "${raw}": use claude, codex, cursor or all.`);
    return 2;
  }
  const r = installSkills({ targets, global: args.includes("--global"), dryRun: args.includes("--dry-run") });
  console.log(r.lines.join("\n"));
  return r.lines.some((l) => l.startsWith("✗")) ? 1 : 0;
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

#!/usr/bin/env node
/**
 *   sap-ui-automation            the stdio MCP server (default)
 *   sap-ui-automation setup      sets up the coding agents found here: the MCP server and the skills (src/cli/agents.ts)
 *   sap-ui-automation init       sets a project up: sap.config.ts, an example test, skills, MCP clients
 *   sap-ui-automation install --skills   copies the bundled agent skills into a project (or --global)
 *   sap-ui-automation doctor     checks what the server can reach on this machine
 *   sap-ui-automation sessions   lists the SAP sessions it finds, then exits
 *   sap-ui-automation browser    opens the SAP window (the Chrome the server starts for Web GUI and Fiori)
 *   sap-ui-automation test       runs *.sap.ts tests (src/runner)
 *   sap-ui-automation extension  unpacks and pairs the Chrome extension (src/cli/extension.ts)
 */
import { disconnectChrome, extensionMode, openSapWindow } from "./browser/chrome.js";
import { browserMode } from "./browser/launch.js";
import { AGENT_COMMANDS, AGENT_HELP, agentCommand, daemonRunning } from "./cli/agent.js";
import { doctorReport } from "./cli/doctor.js";
import { EXTENSION_HELP, extensionCommand } from "./cli/extension.js";
import { init } from "./cli/init.js";
import { AGENT_IDS } from "./cli/agents.js";
import { setupCommand } from "./cli/setup.js";
import { useColor } from "./cli/style.js";
import { installSkills, SKILL_TARGETS, type SkillTarget } from "./cli/skills.js";
import { policyFromEnv } from "./core/guard.js";
import { Registry } from "./core/registry.js";
import { exportCommand, RECORD_HELP, replayCommand } from "./record/cli.js";
import { TEST_HELP, testCommand } from "./runner/cli.js";
import { SERVER_VERSION, sessionLine } from "./server.js";
import { serveStdio } from "./stdio.js";
import { showTraceCommand, TRACE_HELP } from "./trace/cli.js";
import { surfacesFromEnv } from "./surfaces.js";

/** Wraps a list for the help text, indented. */
function wrap(text: string, indent: number, width: number): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && indent + line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map((l) => " ".repeat(indent) + l).join("\n");
}

const HELP = `sap-ui-automation ${SERVER_VERSION}: an MCP server that sees and drives SAP screens you have open.

Usage:
  sap-ui-automation            start the stdio server (what MCP clients run)
  sap-ui-automation setup [<agent>...] [--agent <ids>] [--yes] [--dry-run] [--verbose] [--no-skills] [--no-mcp] [--extension]
                                set up the coding agents found on this machine: the MCP server in each one's config,
                                the skills in its skills folder (one copy in ~/.agents/skills, linked). In a terminal
                                it asks which agents (the ones found are ticked); --yes, or no terminal: every agent
                                found. --agent claude-code,codex (or '*': every one found) names them. --no-skills /
                                --no-mcp: one part only; --dry-run: say what it would do; --verbose: one line per
                                agent, with its paths. --extension: through the Chrome extension (an entry of ours
                                gets SAP_BROWSER=extension), and installs its helper too. Agents:
${wrap(AGENT_IDS.join(", "), 32, 118)}
  sap-ui-automation init [--yes] [--force] [--dry-run]
                                set this project up: sap.config.ts, sap-tests/example.sap.ts, agent skills,
                                MCP clients, .gitignore (asks a few questions; --yes takes the defaults)
  sap-ui-automation install --skills [--target claude|codex|cursor|all] [--global] [--dry-run]
                                copy the bundled agent skills to .claude/skills, .agents/skills, .cursor/rules
                                (--global: ~/.claude/skills, ~/.agents/skills)
  sap-ui-automation doctor     check SAP GUI scripting and Chrome access on this machine
  sap-ui-automation sessions   list the SAP sessions found now
${EXTENSION_HELP}
  sap-ui-automation browser    open the SAP window: the Chrome window the server starts for Web GUI and Fiori.
                                Log on to SAP there once; the agent opens it by itself when it needs SAP.
${RECORD_HELP}
${TRACE_HELP}
${TEST_HELP}
  sap-ui-automation --version | --help

${AGENT_HELP}

Environment:
  SAP_WRITE=off|confirm|on      actions that may write to SAP: refused (default), confirmed by the user in the client
                                (MCP elicitation; refused where the client cannot ask), or allowed
  SAP_ALLOW_SYSTEMS=ABA/800,S4H only these systems (and clients)
  SAP_ALLOW_TCODES / SAP_BLOCK_TCODES   transactions the agent may / may not open or work in
  SAP_ALLOW_ORIGINS=https://myhost:44300  only browser tabs of these origins (comma list)
  SAP_SURFACES=sapgui,webgui,fiori      which kinds of session to look for
  SAP_BROWSER=launch|attach|extension   launch (default): the server starts Google Chrome with a profile of its own (the SAP
                                        window) and works only there. attach: your running Chrome or Edge that allows
                                        remote debugging (chrome://inspect/#remote-debugging). extension:
                                        your everyday Chrome through the sap-ui-automation extension (see extension pair).
  SAP_CHROME_PATH=/path/to/chrome       the Chrome to start, when the server does not find it
  SAP_START_URL=https://myhost/sap/...  the address a new SAP window opens on (after its first use: the last SAP address)
  SAP_CHROME_CDP=http://127.0.0.1:9222  a Chrome DevTools endpoint to attach to; it wins over SAP_BROWSER. A Chrome started
                                        with --remote-debugging-port is used only when named here; Chrome 136+ opens that
                                        port only together with --user-data-dir.
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
  if (cmd === "extension") return extensionCommand(argv.slice(1));
  const agent = { env: process.env, cwd: process.cwd(), out: (l: string) => console.log(l), err: (l: string) => console.error(l) };
  if (AGENT_COMMANDS.has(cmd)) return agentCommand(argv, agent);
  // With a daemon running, the agent CLI's list: the same numbers, and * on its active session.
  if (cmd === "sessions" && (await daemonRunning(agent))) return agentCommand(argv, agent);
  const surfaces = surfacesFromEnv();
  if (cmd === "doctor") {
    const attaching = !process.env.SAP_CHROME_CDP?.trim() && browserMode(process.env) === "attach";
    if (surfaces.some((s) => s.name !== "sapgui"))
      console.error(
        extensionMode(process.env)
          ? "Checking… (waiting up to 35 s for the sap-ui-automation extension in Chrome)\n"
          : attaching
            ? "Checking… (if Chrome asks whether to allow remote debugging, click Allow)\n"
            : "Checking…\n",
      );
    const report = await doctorReport(surfaces, SERVER_VERSION);
    console.log(report.text);
    return report.ok ? 0 : 1;
  }
  if (cmd === "setup") return setupCommand(argv.slice(1), { out: (l) => console.log(l), tty: !!process.stdin.isTTY && !!process.stdout.isTTY, color: useColor(process.stdout) });
  if (cmd === "browser") {
    try {
      const w = await openSapWindow(process.env);
      console.log(w.started ? `Opened the SAP window (Chrome ${w.version}).` : `The SAP window is already open (Chrome ${w.version}), ${w.tabs.length} tab(s).`);
      console.log("Open your SAP system there (Web GUI or Fiori launchpad address) and log on. The agent works on the SAP screen in that window.");
      console.log(`Profile: ${w.profileDir}`);
      return 0;
    } finally {
      await disconnectChrome().catch(() => {});
    }
  }
  if (cmd === "sessions") {
    const r = new Registry(surfaces, policyFromEnv());
    const { sessions, hidden, errors, allFailed, hint } = await r.discover();
    sessions.forEach((s, i) => console.log(sessionLine(s, i, false)));
    if (hidden) console.log(`${hidden} session(s) of systems outside SAP_ALLOW_SYSTEMS are hidden.`);
    for (const e of errors) console.error(e);
    if (!sessions.length) console.log(hint ? `No SAP session found. ${hint}` : "No SAP session found.");
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
    console.error("Usage: sap-ui-automation install --skills [--target claude|codex|cursor|all] [--global] [--dry-run]");
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

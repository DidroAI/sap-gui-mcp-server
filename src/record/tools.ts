/**
 * The two MCP tools of record and replay:
 *
 *   sap_record   start, stop, assert, capture, variable, note, undo, status, code, list, export
 *   sap_replay   run a recorded test again on the active session, with no model
 *
 * Recordings and exports are read and written in one directory
 * (SAP_RECORD_DIR, default ./sap-tests) and named, never addressed by path:
 * an agent cannot make the server read or write elsewhere.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Policy } from "../core/guard.js";
import type { Registry } from "../core/registry.js";
import type { NormalizedAction } from "../core/action.js";
import { codeOf, draftTest } from "../sdk/code.js";
import { exportSapTs, exportTest, TARGET_NAMES, TARGETS } from "./export/index.js";
import { FILE_SUFFIX, inputsOf, slug } from "./format.js";
import type { Recorder } from "./recorder.js";
import { repairSchema } from "./repair.js";
import { replay, resultText } from "./replay.js";

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: t }] });
async function answer(f: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await f();
  } catch (e) {
    return fail((e as Error).message);
  }
}

const OPS = ["start", "stop", "status", "assert", "capture", "variable", "note", "undo", "code", "list", "export"] as const;
const SHOWN_MAX = 6000;

/** Runs a call in the session's turn (server.ts): one call at a time per session. */
export type Serial = (ref: string | undefined, label: string, f: () => Promise<CallToolResult>) => Promise<CallToolResult>;
const direct: Serial = (_ref, _label, f) => f();

/** The actions the server ran on a session, oldest first (server.ts). */
export type History = (sessionId: string) => readonly NormalizedAction[];

export function registerRecordTools(server: McpServer, registry: Registry, policy: Policy, recorder: Recorder, serial: Serial = direct, history: History = () => []): void {
  /** The name of the last recording stopped in this server, for export and replay without a name. */
  let last: string | undefined;
  const session = z.string().optional().describe("session from sap_sessions; default: the active one");

  server.registerTool(
    "sap_record",
    {
      title: "Record the SAP session as a test",
      description: `Records what sap_act does as a repeatable test, with checks. Off until "start". "op":
  {"op":"start","name":"VA03 display order"}  each sap_act that works is a step from now on; begin with an okcode such as /nVA03
  {"op":"assert","check":"status","contains":"saved"}  after the last step; check: status, field (with id), title, transaction, text (anywhere); with equals, contains or matches, or none: the value now
  {"op":"variable","name":"order","value":"19097"}  a value that changes between runs: written \${order} wherever it was typed or expected
  {"op":"capture","name":"order","from":"status","pattern":"Order (\\\\d+)"}  a value SAP produced at the last step (a document number), for the steps after it; from: status, field (with id), title
  {"op":"note","text":"Open the order"}  what the last step is for
  {"op":"undo"}  drops the last step (SAP is not undone); also "status", "code" (the steps so far as a *.sap.ts test), "list", and "stop" (writes <name>${FILE_SUFFIX} in the recordings directory)
  {"op":"export","name":"...","to":"calm"}  ${TARGET_NAMES.join(", ")}
A check or capture that does not hold on the screen now is refused. Typed values are written to the file as typed.`,
      inputSchema: {
        op: z.enum(OPS),
        name: z.string().optional().describe("the recording's (start, export) or the variable's (variable, capture)"),
        description: z.string().optional(),
        replace: z.boolean().optional().describe("start: record over a recording of the same name"),
        check: z.enum(["status", "field", "title", "transaction", "text"]).optional(),
        id: z.string().optional(),
        equals: z.string().optional(),
        contains: z.string().optional(),
        matches: z.string().optional().describe("a regular expression"),
        value: z.string().optional(),
        from: z.enum(["status", "field", "title"]).optional(),
        pattern: z.string().optional().describe("regular expression; its first group is the value"),
        text: z.string().optional(),
        to: z.enum(TARGET_NAMES as [string, ...string[]]).optional(),
        session,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (a) =>
      answer(async () => {
        switch (a.op) {
          case "start": {
            if (!a.name) return fail('start needs "name".');
            const name = a.name;
            return serial(a.session, "sap_record start", async () => {
              const { driver, info } = await registry.session(a.session);
              return text(await recorder.start(driver, info, name, a.description, a.replace === true));
            });
          }
          case "stop": {
            const r = await recorder.stop();
            last = r.test.name;
            return text(r.text);
          }
          case "status":
            return text(recorder.status());
          case "code": {
            const t = recorder.current;
            if (t) return text(exportSapTs(t));
            // No recording: what this server ran on the session, as a draft.
            const id = a.session ? registry.resolve(a.session)?.id : registry.active;
            const done = id ? history(id) : [];
            if (!done.length) return text("No recording is on, and no action ran on this session yet.");
            return text(draftTest({ name: "draft", lines: done.map((x) => codeOf(x)) }));
          }
          case "assert": {
            if (!a.check) return fail('assert needs "check": status, field, title, transaction or text.');
            const check = a.check;
            return serial(a.session, "sap_record assert", async () => text(await recorder.assert(await registry.driver(a.session), { check, id: a.id, equals: a.equals, contains: a.contains, matches: a.matches })));
          }
          case "capture": {
            if (!a.name || !a.from) return fail('capture needs "name" and "from": status, field or title.');
            const [name, from] = [a.name, a.from];
            return serial(a.session, "sap_record capture", async () => text(await recorder.capture(await registry.driver(a.session), { name, from, id: a.id, pattern: a.pattern })));
          }
          case "variable": {
            if (!a.name || a.value === undefined) return fail('variable needs "name" and "value".');
            return text(await recorder.variable(a.name, a.value, a.description));
          }
          case "note":
            return a.text ? text(await recorder.note(a.text)) : fail('note needs "text".');
          case "undo":
            return text(await recorder.undo());
          case "list": {
            const files = (await readdir(recorder.options.dir).catch(() => [] as string[])).filter((f) => f.endsWith(FILE_SUFFIX)).sort();
            return text(files.length ? `Recordings in ${recorder.options.dir}:\n${files.map((f) => `- ${f.slice(0, -FILE_SUFFIX.length)}`).join("\n")}` : `No recording in ${recorder.options.dir}.`);
          }
          case "export": {
            const name = a.name ?? last;
            if (!name) return fail('export needs "name", the recording to export (see {"op":"list"}).');
            if (!a.to) return fail(`export needs "to": ${TARGET_NAMES.map((t) => `${t} (${TARGETS[t].what})`).join("; ")}.`);
            const test = await recorder.load(name);
            const out = exportTest(test, a.to);
            const path = join(recorder.options.dir, `${slug(name.replace(/\.saptest\.json$/i, ""))}${out.suffix}`);
            await mkdir(recorder.options.dir, { recursive: true });
            await writeFile(path, out.text, "utf8");
            const shown = out.text.length > SHOWN_MAX ? `${out.text.slice(0, SHOWN_MAX)}\n... (${out.text.length - SHOWN_MAX} more characters in the file)` : out.text;
            return text(`Written to ${path}\n\n${shown}`);
          }
        }
      }),
  );

  server.registerTool(
    "sap_replay",
    {
      title: "Replay a recorded SAP test",
      description:
        'Runs a recording again on the active session with no model: the same actions on the same ids, under the same write setting and transaction lists as sap_act (steps that may write need SAP_WRITE=on). Answers pass or fail per step and, on a failure, the screen there. A window the recording lacks is confirmed only when it just informs (PASS WITH NOTES); a question or a choice fails the step. "variables" runs it on other data, e.g. {"order":"4711"}.',
      inputSchema: {
        name: z.string().optional().describe("the recording (default: the one just stopped)"),
        variables: z.record(z.string(), z.string()).optional(),
        screens: z.enum(["strict", "loose"]).optional().describe("loose: landing on another screen than recorded is a note, not a failure"),
        choices: z
          .enum(["stop", "continue"])
          .optional()
          .describe("a choice screen the recording lacks (availability check). stop (default): the step fails and names the ways on; continue: press its neutral Continue"),
        // A whole number: .int() would put the safe-integer bounds into tools/list.
        from: z.number().min(1).refine(Number.isInteger, "a whole number").optional().describe("resume at this step on the screen as it is, after a failure there, with that run's variables"),
        repair: repairSchema
          .optional()
          .describe(
            'with "from": a fix for that one step, then the replay goes on as recorded. {"why":"what changed","actions":[...],"place":"before|instead|after"} (at most 4 actions; after: the recorded action already ran) or {"why":"...","capture":{"var":"order","from":"status","pattern":"Order (\\d+)"}} for a number SAP makes anew. Refused: a write the step does not have, leaving the transaction, a typed value neither recorded nor on screen. The recorded checks still judge the step. The answer proposes a test; nothing is saved',
          ),
        format: z.enum(["text", "json"]).optional().describe("json: the result as data (steps, the failure's phase and full screen, the proposed test)"),
        session,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (a) =>
      answer(async () => {
        if (recorder.recording) return fail('A recording is on: stop it first with sap_record {"op":"stop"}.');
        const name = a.name ?? last;
        if (!name) return fail('Give "name", the recording to replay (sap_record {"op":"list"} lists them).');
        const test = await recorder.load(name);
        // The whole replay is one turn of the session: no other call acts in between.
        return serial(a.session, `sap_replay ${test.name}`, async () => {
          const { driver } = await registry.session(a.session);
          const r = await replay(driver, policy, test, { ...(a.variables ? { variables: a.variables } : {}), ...(a.screens ? { screens: a.screens } : {}), ...(a.choices ? { choices: a.choices } : {}), ...(a.from !== undefined ? { from: a.from } : {}), ...(a.repair ? { repair: a.repair } : {}), leaveOnFailure: false });
          const needs = inputsOf(test);
          const said = `${resultText(r)}${r.aborted && needs.length ? `\nThe test takes: ${needs.join(", ")}.` : ""}`;
          const out = a.format === "json" ? JSON.stringify({ ...r, text: said }) : said;
          return r.passed ? text(out) : fail(out);
        });
      }),
  );
}

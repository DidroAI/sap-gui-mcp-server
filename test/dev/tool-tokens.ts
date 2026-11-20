/**
 * Development only: what the tool layer costs an agent in tokens, without
 * SAP. Runs the server in-process on fake sessions with an in-memory client
 * (as test/server.test.ts does) and measures:
 *
 * - the tool definitions as the client gets them from tools/list (name,
 *   title, description, input schema, annotations: the JSON of each tool),
 *   and the server instructions from initialize;
 * - typical answers: sap_look (compact) on the SAP GUI fixtures and on
 *   synthetic Web GUI screens, a sap_act answer that is a diff, a refusal,
 *   sap_sessions.
 *
 *   bun test/dev/tool-tokens.ts [--json FILE] [--dump DIR] [--show] [--write off|confirm|on]
 *
 * Tokens come from the Anthropic count_tokens API when ANTHROPIC_API_KEY is
 * set (tokens.ts). Without a key they are estimated as characters / 4 and
 * the table says so. --dump writes tools-list.json and instructions.txt;
 * --show prints the answers; --write sets SAP_WRITE for the definitions (default off).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { compact } from "../../src/core/compact.js";
import { policyFromEnv } from "../../src/core/guard.js";
import type { Action, Assessment } from "../../src/core/types.js";
import { createServer } from "../../src/server.js";
import { FakeSurface } from "../fakes.js";
import { canCountTokens, countTokens, tokenModel } from "./tokens.js";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const fixture = (name: string) => readFileSync(new URL(`../sapgui/fixtures/expected/${name}.txt`, import.meta.url), "utf8").replace(/\n$/, "");
const SAPGUI = ["easy", "va01", "va03", "va03-texts", "va05", "se80", "f4", "ask"];

// Synthetic Web GUI screens in the reader's full format (the ones the guard tests use).
const WEBGUI: Record<string, string> = {
  "webgui mm03-select-views": [
    "TRANSACTION MM03  PROGRAM SAPLMGMM  SCREEN 60  SYSTEM ABA (800) host",
    'WINDOW wnd[0]  "Display Material (Initial Screen)"',
    "wnd[0]/tbar[0]/okcd  command-field",
    "wnd[0]/tbar[0]/btn[0]  button  Enter (Enter)",
    "wnd[0]/tbar[0]/btn[3]  button  Back (F3)",
    "wnd[0]/tbar[0]/btn[12]  button  Cancel (Escape)",
    "wnd[0]/tbar[1]/btn[5]  button  Select View(s) (F5)",
    "wnd[0]/tbar[1]/btn[6]  button  Org. Levels (F6)",
    "wnd[0]/tbar[1]/btn[7]  button  Data (F7)",
    'wnd[0]/usr/ctxtRMMG1-MATNR  field  Material = "P-109"  (edit)',
    "wnd[0]/mbar  menubar  Material {menu[0]}, Edit {menu[1]}, Goto {menu[2]}, Defaults {menu[3]}, System {menu[4]}, Help {menu[5]}",
    'WINDOW wnd[1]  "Select View(s)"',
    "wnd[1]/usr/tblSAPLMGMMTC_VIEW  table  rows 14 (visible 14); columns: View",
    ...["Basic Data 1", "Basic Data 2", "Classification", "Sales: Sales Org. Data 1", "Sales: Sales Org. Data 2", "Sales: General/Plant Data", "Purchasing", "MRP 1", "MRP 2", "MRP 3", "MRP 4", "Plant data / stor. 1", "Accounting 1", "Costing 1"].map(
      (v, i) => `  row ${i}: View = "${v}"`,
    ),
    "wnd[1]/usr/chkUSRM1-AAUSW  checkbox  [ ] View selection only on request",
    "wnd[1]/tbar[0]/btn[0]  button  Continue (Enter)",
    "wnd[1]/tbar[0]/btn[6]  button  Org. Levels (F6)",
    "wnd[1]/tbar[0]/btn[7]  button  Data (F7)",
    "wnd[1]/tbar[0]/btn[20]  button  Select All (Shift+F8)",
    "wnd[1]/tbar[0]/btn[21]  button  Deselect All (Shift+F9)",
    "wnd[1]/tbar[0]/btn[14]  button  Default Setting  (Save as Default Values (Shift+F2))",
    "wnd[1]/tbar[0]/btn[12]  button  Cancel (Escape)",
  ].join("\n"),
};

type Row = { group: string; name: string; text: string };

async function main() {
  const surface = new FakeSurface("webgui");
  const { server } = createServer({ policy: policyFromEnv({ SAP_WRITE: opt("--write") ?? "off" }), surfaces: [surface], view: "diff" });
  const client = new Client({ name: "tool-tokens", version: "0" }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, a: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: a })) as { content: { type: string; text?: string }[] };
    return r.content.map((c) => c.text ?? `<${c.type}>`).join("\n");
  };

  const rows: Row[] = [];
  const { tools } = await client.listTools();
  const instructions = client.getInstructions() ?? "";
  for (const t of tools) rows.push({ group: "definitions", name: t.name, text: JSON.stringify(t) });
  rows.push({ group: "definitions", name: "instructions", text: instructions });
  const dump = opt("--dump");
  if (dump) {
    mkdirSync(dump, { recursive: true });
    writeFileSync(join(dump, "tools-list.json"), `${JSON.stringify({ tools }, null, 2)}\n`);
    writeFileSync(join(dump, "instructions.txt"), `${instructions}\n`);
  }

  // Answers. Each session's view is the compact view of a fixture, as a driver gives it.
  const screens: [string, string][] = [...SAPGUI.map((n): [string, string] => [`sapgui ${n}`, fixture(n)]), ...Object.entries(WEBGUI)];
  for (const [i, [name, full]] of screens.entries()) surface.add({ id: `s${i}`, system: "ABA", client: "800", user: "DEMO", transaction: /^TRANSACTION (\S+)/.exec(full)?.[1] ?? "", title: /^WINDOW wnd\[0\]\s+"(.*)"$/m.exec(full)?.[1] ?? "" }, { view: compact(full) });
  for (const [i, [name]] of screens.entries()) rows.push({ group: "sap_look (compact)", name, text: await call("sap_look", { session: `s${i}` }) });

  // sap_act on the same screen: one field typed, the answer is the diff.
  const va01 = compact(fixture("va01"));
  const save = (x: Action): Assessment => (x.do === "key" && x.key === 11 ? { risk: "commit", reason: "key 11: Save (Ctrl+S)" } : { risk: "navigate", reason: x.do });
  surface.add(
    { id: "act", system: "ABA", client: "800", user: "DEMO", transaction: "VA01", title: "Create Sales Order: Initial Screen" },
    {
      view: va01,
      assess: save,
      onAct: (_x, s) => {
        s.view = (s.view ?? "").replace('Sales Organization = ""', 'Sales Organization = "1000"');
      },
    },
  );
  await call("sap_look", { session: "act" });
  rows.push({ group: "answers", name: "sap_act set (diff)", text: await call("sap_act", { session: "act", action: { do: "set", id: "ctxtVBAK-VKORG", value: "1000" } }) });
  // A batch on a second VA01 session: two fields typed, then Enter (the fake leaves the screen as it is).
  surface.add(
    { id: "batch", system: "ABA", client: "800", user: "DEMO", transaction: "VA01", title: "Create Sales Order: Initial Screen" },
    {
      view: va01,
      assess: save,
      onAct: (x, s) => {
        const label = x.id === "ctxtVBAK-VKORG" ? "Sales Organization" : x.id === "ctxtVBAK-VTWEG" ? "Distribution Channel" : undefined;
        if (x.do === "set" && label) s.view = (s.view ?? "").replace(`${label} = ""`, `${label} = "${String(x.value)}"`);
      },
    },
  );
  await call("sap_look", { session: "batch" });
  rows.push({
    group: "answers",
    name: "sap_act batch (2 sets + Enter)",
    text: await call("sap_act", { session: "batch", actions: [{ do: "set", id: "ctxtVBAK-VKORG", value: "1000" }, { do: "set", id: "ctxtVBAK-VTWEG", value: "10" }, { do: "key", key: 0 }] }),
  });
  rows.push({ group: "answers", name: "sap_act Save refused (SAP_WRITE=off)", text: await call("sap_act", { session: "act", action: { do: "key", key: 11 } }) });
  rows.push({ group: "answers", name: "sap_act command field refused", text: await call("sap_act", { session: "act", action: { do: "set", id: "okcd", value: "/nVA03" } }) });
  rows.push({ group: "answers", name: `sap_sessions (${surface.sessions.length} sessions)`, text: await call("sap_sessions") });

  // The same Save with SAP_WRITE=confirm and a client that cannot ask the user: the token answer.
  const held = new FakeSurface("webgui");
  held.add({ id: "act", system: "ABA", client: "800", transaction: "VA01", title: "Create Sales Order: Initial Screen" }, { view: va01, assess: save });
  const second = createServer({ policy: policyFromEnv({ SAP_WRITE: "confirm" }), surfaces: [held] });
  const client2 = new Client({ name: "tool-tokens", version: "0" }, { capabilities: {} });
  const [c, d] = InMemoryTransport.createLinkedPair();
  await Promise.all([second.server.connect(c), client2.connect(d)]);
  const r2 = (await client2.callTool({ name: "sap_act", arguments: { action: { do: "key", key: 11 } } })) as { content: { text?: string }[] };
  rows.push({ group: "answers", name: "sap_act Save held for confirmation (token)", text: r2.content.map((x) => x.text ?? "").join("\n") });
  await client2.close();

  const counted = await countTokens(rows.map((r) => r.text));
  const unit = counted ? `tokens (${tokenModel}, count_tokens API)` : "tokens estimated as characters / 4 (no ANTHROPIC_API_KEY)";
  const tok = (i: number) => counted?.[i] ?? Math.round((rows[i]?.text.length ?? 0) / 4);
  const out = rows.map((r, i) => ({ ...r, chars: r.text.length, tokens: tok(i) }));
  console.log(`Unit: ${unit}\n`);
  console.log("| group | item | chars | tokens |\n| --- | --- | ---: | ---: |");
  for (const r of out) console.log(`| ${r.group} | ${r.name} | ${r.chars} | ${r.tokens} |`);
  if (args.includes("--show")) for (const r of out.filter((x) => x.group === "answers")) console.log(`\n--- ${r.name}\n${r.text}`);
  const sum = (g: string, f: (r: (typeof out)[number]) => boolean = () => true) => out.filter((r) => r.group === g && f(r)).reduce((s, r) => s + r.tokens, 0);
  console.log(`\nTool definitions (${tools.length} tools): ${sum("definitions", (r) => r.name !== "instructions")} tokens; with the instructions: ${sum("definitions")} tokens.`);
  const looks = out.filter((r) => r.group === "sap_look (compact)");
  console.log(`sap_look compact: ${looks.length} screens, mean ${Math.round(looks.reduce((s, r) => s + r.tokens, 0) / looks.length)} tokens.`);
  const json = opt("--json");
  if (json) writeFileSync(json, `${JSON.stringify({ unit, exact: canCountTokens() && !!counted, rows: out.map(({ group, name, chars, tokens }) => ({ group, name, chars, tokens })) }, null, 2)}\n`);
  await client.close();
}

await main();

/**
 * Development only: what each rule of the compact view saves, on real
 * screens. Two steps, so that the counting can be repeated without SAP:
 *
 *   SAP_CHROME_CDP=http://127.0.0.1:9421 bun test/dev/measure.ts capture DIR
 *     walks a Web GUI session that is logged on through a list of screens
 *     (VA01, VA03, VA05, SE16N, SE16, MM03; nothing is saved) and writes the
 *     full view of each to DIR/<screen>.txt. Screen content: keep DIR out of Git.
 *
 *   bun test/dev/measure.ts count DIR [--before ROOT]
 *     counts each screen's full view, its compact view with every rule off
 *     and with all rules on, and what each rule saves: the compact view with
 *     all rules, less the one with all rules but that one (the rules overlap,
 *     so a rule is counted by what taking it away would cost). With --before,
 *     also the compact view of the server at ROOT (an older checkout).
 *
 * Tokens come from the Anthropic count_tokens API when ANTHROPIC_API_KEY is
 * set (see tokens.ts), else the table holds characters.
 *
 * Same data as soak.ts: SOAK_ORDER, SOAK_ORDER_TO, SOAK_CUSTOMER,
 * SOAK_MATERIAL, SOAK_PLANT, SOAK_SALES.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { compact, type CompactOptions } from "../../src/core/compact.js";
import { policyFromEnv } from "../../src/core/guard.js";
import { createServer } from "../../src/server.js";
import { webguiSurface } from "../../src/webgui/index.js";
import { countTokens, tokenModel } from "./tokens.js";

const [mode, dir] = process.argv.slice(2);
if ((mode !== "capture" && mode !== "count") || !dir) throw new Error("usage: measure.ts capture DIR | count DIR [--before ROOT]");

const ORDER = process.env.SOAK_ORDER ?? "4969";
const ORDER_TO = process.env.SOAK_ORDER_TO ?? "9000";
const CUSTOMER = process.env.SOAK_CUSTOMER ?? "2000";
const MATERIAL = process.env.SOAK_MATERIAL ?? "P-109";
const PLANT = process.env.SOAK_PLANT ?? "1000";
const [VKORG = "1000", VTWEG = "10", SPART = "00"] = (process.env.SOAK_SALES ?? "1000/10/00").split("/");

type A = Record<string, unknown>;
const ok = (value: string): A => ({ do: "okcode", value });
const set = (id: string, value: string): A => ({ do: "set", id, value });
const key = (k: number): A => ({ do: "key", key: k });

/** Each screen: the actions that lead to it from the one before, and its name. */
const SCREENS: { name: string; actions: A[] }[] = [
  { name: "easy-access", actions: [] },
  { name: "va01-initial", actions: [ok("/nVA01")] },
  { name: "va01-overview", actions: [set("ctxtVBAK-AUART", "OR"), set("ctxtVBAK-VKORG", VKORG), set("ctxtVBAK-VTWEG", VTWEG), set("ctxtVBAK-SPART", SPART), key(0), set("ctxtKUAGV-KUNNR", CUSTOMER), key(0)] },
  { name: "va03-initial", actions: [ok("/nVA03")] },
  { name: "va03-overview", actions: [set("ctxtVBAK-VBELN", ORDER), key(0)] },
  { name: "va03-header", actions: [{ do: "press", id: "btnBT_HEAD" }] },
  { name: "va03-header-texts", actions: [{ do: "select", id: "tabpT\\08" }] },
  { name: "va05-selection", actions: [ok("/nVA05")] },
  { name: "va05-list", actions: [set("ctxtSVBELN-LOW", ORDER), set("ctxtSVBELN-HIGH", ORDER_TO), key(8)] },
  { name: "se16n-selection", actions: [ok("/nSE16N"), set("ctxtGD-TAB", "VBAK"), key(0)] },
  { name: "se16n-result", actions: [key(8)] },
  { name: "se16-list", actions: [ok("/nSE16"), set("ctxtDATABROWSE-TABLENAME", "TVAKT"), key(0), set("ctxtI1-LOW", "EN"), key(8)] },
  { name: "mm03-select-views", actions: [ok("/nMM03"), set("ctxtRMMG1-MATNR", MATERIAL), key(0)] },
  { name: "mm03-basic-data", actions: [{ do: "press", id: "wnd[1]/tbar[0]/btn[20]" }, key(0), set("ctxtRMMG1-WERKS", PLANT), key(0)] },
  { name: "mm03-mrp1", actions: [{ do: "select", id: "tabpSP12" }] },
];

if (mode === "capture") {
  const env = { SAP_CHROME_CDP: process.env.SAP_CHROME_CDP ?? "", SAP_SURFACES: "webgui", SAP_WRITE: "on" };
  if (!env.SAP_CHROME_CDP) throw new Error("SAP_CHROME_CDP is not set");
  const { server } = createServer({ policy: policyFromEnv(env), surfaces: [webguiSurface(env)] });
  const client = new Client({ name: "measure", version: "0" }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: A) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
    return { error: r.isError === true, text: r.content.map((c) => c.text ?? "").join("\n") };
  };
  mkdirSync(dir, { recursive: true });
  try {
    for (const s of SCREENS) {
      for (const action of s.actions) {
        // No step saves: Save is key 11, and none is sent.
        if (action.do === "key" && action.key === 11) throw new Error("this script never saves");
        const r = await call("sap_act", { action });
        if (r.error) console.log(`  ${s.name}: ${JSON.stringify(action)} -> ${r.text.split("\n")[0]}`);
      }
      const full = await call("sap_look", { full: true });
      writeFileSync(join(dir, `${s.name}.txt`), `${full.text}\n`);
      console.log(`${s.name}: ${full.text.split("\n").length} lines, ${(full.text.split("\n")[1] ?? "").slice(0, 80)}`);
    }
  } finally {
    // Leave on SAP Easy Access: Cancel closes a popup, /n leaves a transaction.
    for (let i = 0; i < 6; i++) {
      const now = (await call("sap_look", {})).text;
      if (/WINDOW wnd\[[1-9]/.test(now)) await call("sap_act", { action: key(12) });
      else if (/^WINDOW wnd\[0\] {2}"SAP Easy Access/m.test(now)) break;
      else if (/btnSTARTBUTTON/.test(now)) await call("sap_act", { action: { do: "press", id: "btnSTARTBUTTON" } });
      else await call("sap_act", { action: ok("/n") });
    }
  }
  process.exit(0);
}

// ---- count ---------------------------------------------------------------------

const OFF: CompactOptions = { handles: false, repeatedButtons: false, dropdowns: false, lists: false, emptyColumns: false, shortRows: false, maxChars: 0 };
const ALL: CompactOptions = { maxChars: 0 };
const RULES: { name: string; off: CompactOptions }[] = [
  { name: "handles", off: { handles: false } },
  { name: "same buttons", off: { repeatedButtons: false } },
  { name: "dropdowns", off: { dropdowns: false } },
  { name: "table rows", off: { shortRows: false } },
  { name: "empty cols", off: { emptyColumns: false } },
  { name: "lists", off: { lists: false } },
];

const beforeAt = process.argv.indexOf("--before");
const before = beforeAt > 0 ? ((await import(`${process.argv[beforeAt + 1]}/src/core/compact.ts`)) as { compact: (full: string) => string }).compact : undefined;

const files = readdirSync(dir)
  .filter((f) => f.endsWith(".txt"))
  .sort((x, y) => SCREENS.findIndex((s) => `${s.name}.txt` === x) - SCREENS.findIndex((s) => `${s.name}.txt` === y));
const columns = ["full", ...(before ? ["before"] : []), "rules off", ...RULES.map((r) => r.name), "all rules"];
const texts: string[] = [];
for (const f of files) {
  const full = readFileSync(join(dir, f), "utf8").replace(/\n$/, "");
  texts.push(full);
  if (before) texts.push(before(full));
  texts.push(compact(full, OFF));
  for (const r of RULES) texts.push(compact(full, { ...ALL, ...r.off }));
  texts.push(compact(full, ALL));
}
const tokens = await countTokens(texts);
const size = (i: number) => (tokens ? (tokens[i] ?? 0) : (texts[i] ?? "").length);
const n = columns.length;
console.log(`${tokens ? `tokens (${tokenModel})` : "characters"}; a rule's column is what it saves: "all rules" less the view without that rule`);
console.log(["screen".padEnd(20), ...columns.map((c) => c.padStart(13))].join(""));
const totals = new Array<number>(n).fill(0);
const saved = new Array<number>(n).fill(0);
files.forEach((f, row) => {
  const cells = columns.map((c, col) => {
    const v = size(row * n + col);
    totals[col] = (totals[col] ?? 0) + v;
    const all = size(row * n + columns.indexOf("all rules"));
    // A single rule: what it saves, not what is left.
    if (RULES.some((r) => r.name === c)) saved[col] = (saved[col] ?? 0) + all - v;
    return RULES.some((r) => r.name === c) ? String(all - v) : String(v);
  });
  console.log([f.replace(/\.txt$/, "").padEnd(20), ...cells.map((c) => c.padStart(13))].join(""));
});
console.log(["total".padEnd(20), ...columns.map((c, col) => String(RULES.some((r) => r.name === c) ? (saved[col] ?? 0) : (totals[col] ?? 0)).padStart(13))].join(""));

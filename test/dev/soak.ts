/**
 * Development only: a long read-only run through the server, to find what
 * breaks over many steps and what each step costs in tokens.
 *
 * It talks to the server as an agent does (the MCP tools, in process), on a
 * Web GUI session that is already logged on, and walks VA01 (never saved),
 * VA03, VA05, SE16N, SE16 and MM03, then goes back to SAP Easy Access. It
 * never saves: no step sends Save, and the script refuses to run one that
 * would.
 *
 *   SAP_CHROME_CDP=http://127.0.0.1:9421 bun test/dev/soak.ts [options]
 *
 *   --view full|diff   what sap_act answers with (default: the server's default)
 *   --skip-new         leave out the steps that need scroll, rows and entries (to run an older server)
 *   --rounds N         walk the flow N times (default 1)
 *   --out FILE         write the numbers as JSON (step names and numbers only, no screen content)
 *   --texts DIR        also write each answer to DIR (screen content: keep it out of Git)
 *
 * The defaults below are keys of SAP's IDES demo data; set your own for
 * another system.
 *
 *   SOAK_SRC       root of the server to test (default: this checkout)
 *   SOAK_ORDER     a sales order that exists (default 4969)
 *   SOAK_ORDER_TO  the end of an order range with a few hundred orders (default 9000)
 *   SOAK_CUSTOMER  a customer VA01 takes as sold-to party without a popup (default 2000)
 *   SOAK_MATERIAL  a material with a plant view (default P-109)
 *   SOAK_PLANT     that plant (default 1000)
 *   SOAK_SALES     sales area as org/channel/division (default 1000/10/00)
 *
 * Tokens are counted with the Anthropic count_tokens API when
 * ANTHROPIC_API_KEY is set (see tokens.ts), else characters are reported.
 * Exit code 1 when a step failed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { countTokens, tokenModel } from "./tokens.js";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const SRC = resolve(process.env.SOAK_SRC ?? join(import.meta.dir, "../.."));
const ORDER = process.env.SOAK_ORDER ?? "4969";
const ORDER_TO = process.env.SOAK_ORDER_TO ?? "9000";
const CUSTOMER = process.env.SOAK_CUSTOMER ?? "2000";
const MATERIAL = process.env.SOAK_MATERIAL ?? "P-109";
const PLANT = process.env.SOAK_PLANT ?? "1000";
const [VKORG = "1000", VTWEG = "10", SPART = "00"] = (process.env.SOAK_SALES ?? "1000/10/00").split("/");

interface Step {
  name: string;
  /** sap_act with this action, or sap_look with these arguments. */
  act?: Record<string, unknown>;
  look?: Record<string, unknown>;
  /** The answer must match (the screen the step should lead to). */
  expect?: RegExp;
  /** Needs scroll, rows or entries: skipped with --skip-new. */
  isNew?: boolean;
}

const ok = (value: string): Step => ({ name: `okcode ${value}`, act: { do: "okcode", value } });
// A field that already holds the value answers "NO CHANGE" when the server sends only what changed.
const set = (id: string, value: string): Step => ({ name: `set ${id}`, act: { do: "set", id, value }, expect: new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*"${value}"|NO CHANGE`) });
const key = (k: number, expect?: RegExp, name?: string): Step => ({ name: name ?? `key ${k}`, act: { do: "key", key: k }, ...(expect ? { expect } : {}) });

const FLOW: Step[] = [
  { name: "look Easy Access", look: {}, expect: /SAP Easy Access/ },
  // VA01, never saved.
  { ...ok("/nVA01"), expect: /TRANSACTION VA01/ },
  set("ctxtVBAK-AUART", "OR"),
  set("ctxtVBAK-VKORG", VKORG),
  set("ctxtVBAK-VTWEG", VTWEG),
  set("ctxtVBAK-SPART", SPART),
  key(0, /Create Standard Order: Overview/, "Enter to the VA01 overview"),
  set("ctxtKUAGV-KUNNR", CUSTOMER),
  set("txtVBKD-BSTKD", "SOAK-TEST"),
  { name: "tab Item overview", act: { do: "select", id: "tabpT\\02" }, expect: /Item overview \(selected\)|Item overview.*selected/ },
  { name: "tab Shipping", act: { do: "select", id: "tabpT\\06" }, expect: /Shipping \(selected\)|Shipping.*selected/ },
  { name: "tab Sales", act: { do: "select", id: "tabpT\\01" }, expect: /Sales \(selected\)|Sales.*selected/ },
  { name: "entries of a dropdown", act: { do: "combo", id: "cmbVBAK-LIFSK" }, expect: /entries/i, isNew: true },
  // VA03: leaves VA01 without saving.
  { ...ok("/nVA03"), expect: /TRANSACTION VA03/ },
  set("ctxtVBAK-VBELN", ORDER),
  key(0, new RegExp(`Display Standard Order ${ORDER}: Overview`), "Enter to the VA03 overview"),
  { name: "tab Item overview", act: { do: "select", id: "tabpT\\02" }, expect: /Item overview \(selected\)|Item overview.*selected/ },
  { name: "header details", act: { do: "press", id: "btnBT_HEAD" }, expect: /Header Data/ },
  { name: "tab Texts", act: { do: "select", id: "tabpT\\08" }, expect: /  tree  / },
  { name: "tab Status", act: { do: "select", id: "tabpT\\10" }, expect: /Status/ },
  { name: "tab Sales", act: { do: "select", id: "tabpT\\01" }, expect: /Order Type/ },
  key(3, /Overview/, "Back to the overview"),
  // VA05: a list of a few hundred orders.
  { ...ok("/nVA05"), expect: /TRANSACTION VA05/ },
  set("ctxtSVBELN-LOW", ORDER),
  set("ctxtSVBELN-HIGH", ORDER_TO),
  key(8, /  grid  \d+ rows/, "F8 to the VA05 list"),
  { name: "scroll the list down", act: { do: "scroll", id: "shell", to: "next" }, expect: /row \d+:/, isNew: true },
  { name: "scroll the list to row 60", act: { do: "scroll", id: "shell", to: 60 }, expect: /row 6\d:/, isNew: true },
  { name: "rows 30 to 59 of the list", look: { id: "shell", rows: "30-59" }, expect: /row 30:[^]*row 59:/, isNew: true },
  { name: "select a row that is not on screen", act: { do: "grid", id: "shell", row: 5, col: "VBELN", how: "select" }, expect: /scrolled to it/, isNew: true },
  { name: "a row the list does not have", act: { do: "grid", id: "shell", row: 5000, col: "VBELN", how: "select" }, expect: /^(?!grid select)[^]*the list has \d+ rows/, isNew: true },
  // A double-click would open VA02 (change): the row is only selected.
  { name: "select the first row of the list", act: { do: "grid", id: "shell", row: 0, col: "VBELN", how: "select" }, expect: /  grid  \d+ rows|NO CHANGE/ },
  key(3, /List of Sales Orders/, "Back to the VA05 selection"),
  // SE16N: a table control with 170 rows, then a grid with 500.
  { ...ok("/nSE16N"), expect: /TRANSACTION SE16N/ },
  set("ctxtGD-TAB", "VBAK"),
  key(0, /Selection Criteria/, "Enter in SE16N"),
  { name: "scroll the selection table to row 60", act: { do: "scroll", id: "tblSAPLSE16NSELFIELDS_TC", to: 60 }, expect: /table  /, isNew: true },
  { name: "scroll the selection table back", act: { do: "scroll", id: "tblSAPLSE16NSELFIELDS_TC", to: 0 }, expect: /Client/, isNew: true },
  key(8, /  grid  \d+ rows/, "F8 to the SE16N result"),
  { name: "scroll the result to row 400", act: { do: "scroll", id: "shell", to: 400 }, expect: /row 400:/, isNew: true },
  { name: "scroll the result up a page", act: { do: "scroll", id: "shell", to: "prev" }, expect: /row \d+:/, isNew: true },
  key(3, /Selection Criteria/, "Back to the SE16N selection"),
  // SE16: a classic list.
  { ...ok("/nSE16"), expect: /TRANSACTION SE16/ },
  set("ctxtDATABROWSE-TABLENAME", "TVAKT"),
  key(0, /Selection Screen/, "Enter in SE16"),
  set("ctxtI1-LOW", "EN"),
  key(8, /Promotion Order/, "F8 to the SE16 list"),
  { name: "scroll the classic list down", act: { do: "scroll", id: "usr", to: "next" }, expect: /first \d+/, isNew: true },
  { name: "look at the list again", look: {}, expect: /  row \d+: / },
  key(3, /Selection Screen/, "Back to the SE16 selection"),
  // MM03: two popups, then a screen with 29 tabs.
  { ...ok("/nMM03"), expect: /TRANSACTION MM03/ },
  set("ctxtRMMG1-MATNR", MATERIAL),
  key(0, /Select View/, "Enter to the view selection"),
  { name: "select all views", act: { do: "press", id: "wnd[1]/tbar[0]/btn[20]" }, expect: /Select View|NO CHANGE|CHANGED/ },
  key(0, /Organizational Levels/, "Enter to the organisational levels"),
  set("ctxtRMMG1-WERKS", PLANT),
  key(0, new RegExp(`Display Material ${MATERIAL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "Enter to the material"),
  { name: "tab Basic Data 2", act: { do: "select", id: "tabpSP02" }, expect: /Basic Data 2 \(selected\)|Basic Data 2.*selected/ },
  { name: "tab MRP 1", act: { do: "select", id: "tabpSP12" }, expect: /MRP 1 \(selected\)|MRP 1.*selected/ },
  { name: "an id of the previous screen", act: { do: "set", id: "ctxtVBAK-VBELN", value: "1" }, expect: /^(?!.*set ).*(No control|no control)/s },
  { ...ok("/n"), name: "okcode /n: leave the transaction", expect: /SAP Easy Access|Start SAP Easy Access/ },
  { name: "look at the start screen", look: {}, expect: /SAP Easy Access/ },
];

/** A step that could save must never run here. */
function wouldSave(s: Step): boolean {
  const a = s.act;
  if (!a) return false;
  if (a.do === "key" && (a.key === 11 || /^(control\+s|11)$/i.test(String(a.key)))) return true;
  if (a.do === "okcode" && /^\/?11$|SAVE|\/nex|\/nend|\/i\b/i.test(String(a.value)) && a.value !== "/n") return true;
  if (/btn\[11\]/.test(String(a.id ?? ""))) return true;
  return false;
}

const view = arg("view");
const env: Record<string, string> = {
  SAP_CHROME_CDP: process.env.SAP_CHROME_CDP ?? "",
  SAP_SURFACES: "webgui",
  // Popups (view selection, organisational levels) count as writes for the guard: the flow answers them, and never saves.
  SAP_WRITE: "on",
  ...(view ? { SAP_VIEW: view } : {}),
};
if (!env.SAP_CHROME_CDP) throw new Error("SAP_CHROME_CDP is not set: point it at a Chrome with a Web GUI tab that is logged on");

const { createServer } = (await import(`${SRC}/src/server.ts`)) as typeof import("../../src/server.js");
const { policyFromEnv } = (await import(`${SRC}/src/core/guard.ts`)) as typeof import("../../src/core/guard.js");
const { webguiSurface } = (await import(`${SRC}/src/webgui/index.ts`)) as typeof import("../../src/webgui/index.js");

// An older server has no "view" option and ignores it.
const { server } = createServer({ policy: policyFromEnv(env), surfaces: [webguiSurface(env)], ...(view ? { view: view as "diff" | "full" } : {}) });
const client = new Client({ name: "soak", version: "0" }, { capabilities: {} });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);

interface Result {
  round: number;
  n: number;
  name: string;
  ok: boolean;
  why: string;
  ms: number;
  chars: number;
  tokens?: number;
  isNew: boolean;
}
const results: Result[] = [];
const answers: string[] = [];

async function call(s: Step): Promise<{ error: boolean; text: string }> {
  const r = (await client.callTool(s.look ? { name: "sap_look", arguments: s.look } : { name: "sap_act", arguments: { action: s.act } })) as {
    isError?: boolean;
    content: { type: string; text?: string }[];
  };
  return { error: r.isError === true, text: r.content.map((c) => c.text ?? "").join("\n") };
}

/**
 * Brings the session to SAP Easy Access: Cancel closes a popup (never Enter,
 * which could confirm something), /n leaves a transaction, and the old start
 * screen has a button for it.
 */
async function toEasyAccess(): Promise<void> {
  const look = async () => ((await client.callTool({ name: "sap_look", arguments: {} })) as { content: { text?: string }[] }).content.map((c) => c.text ?? "").join("\n");
  const act = (action: Record<string, unknown>) => client.callTool({ name: "sap_act", arguments: { action } }).catch(() => undefined);
  for (let i = 0; i < 6; i++) {
    const screen = await look().catch(() => "");
    if (/WINDOW wnd\[[1-9]/.test(screen)) await act({ do: "key", key: 12 });
    else if (/^WINDOW wnd\[0\] {2}"SAP Easy Access/m.test(screen)) return;
    else if (/btnSTARTBUTTON/.test(screen)) await act({ do: "press", id: "btnSTARTBUTTON" });
    else await act({ do: "okcode", value: "/n" });
  }
}

const rounds = Number(arg("rounds") ?? 1);
await toEasyAccess();
const skipNew = flag("skip-new");
try {
  for (let round = 1; round <= rounds; round++) {
    let n = 0;
    for (const s of FLOW) {
      if (s.isNew && skipNew) continue;
      if (wouldSave(s)) throw new Error(`step "${s.name}" could save: not run`);
      n++;
      const t0 = Date.now();
      let res: { error: boolean; text: string };
      try {
        res = await call(s);
      } catch (e) {
        res = { error: true, text: `(the call failed: ${(e as Error).message})` };
      }
      const ms = Date.now() - t0;
      // "an id of the previous screen" expects a refusal: there the error is the pass.
      const wantsError = s.name.startsWith("an id of the previous screen") || s.name.startsWith("a row the list does not have");
      const matched = !s.expect || s.expect.test(res.text);
      const good = matched && (wantsError ? res.error : !res.error);
      const why = good ? "" : res.error && !wantsError ? (res.text.split("\n")[0] ?? "").slice(0, 160) : `the answer does not match ${s.expect}`;
      results.push({ round, n, name: s.name, ok: good, why, ms, chars: res.text.length, isNew: !!s.isNew });
      answers.push(res.text);
      console.log(`${String(round).padStart(2)}.${String(n).padStart(2, "0")} ${good ? "ok  " : "FAIL"} ${String(ms).padStart(6)} ms ${String(res.text.length).padStart(6)} chars  ${s.name}${good ? "" : `  <- ${why}`}`);
    }
  }
} finally {
  // Always leave the session on SAP Easy Access, whatever failed on the way.
  await toEasyAccess();
}

const tokens = await countTokens(answers);
if (tokens) results.forEach((r, i) => (r.tokens = tokens[i] ?? 0));

const sum = (xs: number[]) => xs.reduce((x, y) => x + y, 0);
const failed = results.filter((r) => !r.ok);
const common = results.filter((r) => !r.isNew);
const line = (label: string, rs: Result[]) =>
  `${label}: ${rs.length} steps, ${sum(rs.map((r) => r.chars))} chars${tokens ? `, ${sum(rs.map((r) => r.tokens ?? 0))} tokens (${tokenModel})` : ""}, ${Math.round(sum(rs.map((r) => r.ms)) / 100) / 10} s`;
console.log("");
console.log(line("all steps", results));
if (common.length !== results.length) console.log(line("steps an older server also runs", common));
if (tokens) {
  const worst = [...results].sort((x, y) => (y.tokens ?? 0) - (x.tokens ?? 0)).slice(0, 5);
  console.log(`largest answers: ${worst.map((r) => `${r.name} ${r.tokens}`).join("; ")}`);
}
console.log(failed.length ? `FAILED ${failed.length}: ${failed.map((r) => `${r.round}.${r.n} ${r.name}`).join("; ")}` : "no failure");

const out = arg("out");
if (out) writeFileSync(out, `${JSON.stringify({ src: SRC, view: view ?? "default", skipNew, rounds, tokenModel: tokens ? tokenModel : null, results }, null, 1)}\n`);
const texts = arg("texts");
if (texts) {
  mkdirSync(texts, { recursive: true });
  results.forEach((r, i) => writeFileSync(join(texts, `${String(r.round).padStart(2, "0")}-${String(r.n).padStart(2, "0")}.txt`), `# ${r.name}\n${answers[i]}\n`));
}
process.exit(failed.length ? 1 : 0);

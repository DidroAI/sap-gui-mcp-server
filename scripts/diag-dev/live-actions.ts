/**
 * live-actions.ts: checks the actions of the DIAG method on a real SAP GUI,
 * one at a time, with a person watching. Run it on the Windows machine where
 * SAP GUI runs, in the desktop session (keyboard and mouse go to the screen):
 *
 *   bun scripts/diag-dev/live-actions.ts [check ...]
 *
 * It starts the method's router (SAP_DIAG_PORT, default 3298) and waits for
 * SAP GUI to connect through it: log on with a connection entry whose
 * SAProuter string starts with /H/127.0.0.1/S/3298. Then each check moves
 * to its screen with a transaction (by default from an ECC demo system:
 * change them with the environment variables named below), runs its action,
 * and prints the answer, the timing and the part of the view it concerns.
 * Before each action it prints the guard's rating and refuses anything
 * rated "commit": nothing is saved. A check waits for Enter before it acts,
 * so the person can put the screen where the check needs it.
 *
 * Checks (all by default, in this order):
 *   wait      Enter on a screen; then a report with F8 (LIVE_REPORT, default /nVA05 with
 *             its own selection) and the time SAP took: the wait must end with the list
 *   cells     the cell size SAP GUI reported, the area, and a click into a field (set)
 *   combo     a dropdown (LIVE_COMBO_TCODE, LIVE_COMBO_ID, LIVE_COMBO_TEXT)
 *   table     scroll a table control (LIVE_TABLE_TCODE, LIVE_TABLE_ID): next, prev, a row
 *   list      scroll a classic list (LIVE_LIST_TCODE): next, last, first
 *   grid      a grid (on the screen the person opened): cell, double, select row, scroll, rows
 *   toolbar   a grid's toolbar button (LIVE_TOOLBAR, default &SORT_ASC)
 *   tree      a tree (on the screen the person opened): expand, collapse, select, double
 *   look      sap_look with id and rows on the screen's first grid, table or list
 *   sessions  two sessions (/o) with the same transaction: both are found, each acts in its own window
 *
 * What it prints goes to the live-check list of the actions report. It holds
 * SAP data from the system it runs on: keep the output local.
 */
import { createInterface } from "node:readline/promises";
import { normalizeAction } from "../../src/core/action.js";
import type { Action, Driver, SessionInfo } from "../../src/core/types.js";
import { sapguiDiagSurface } from "../../src/sapgui-diag/index.js";
import { scrollables } from "../../src/sapgui-diag/plan.js";

const env = process.env;
const surface = sapguiDiagSurface(env, { log: (m) => console.log(`[router] ${m}`) });
const rl = createInterface({ input: process.stdin, output: process.stdout });
const pause = (what: string) => rl.question(`\n>> ${what}. Press Enter to go on (or type "skip"): `);

async function session(n = 0): Promise<SessionInfo> {
  for (;;) {
    const all = await surface.discover();
    if (all.length > n) return all[n] as SessionInfo;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** One action: the guard's rating, then the action, its answer and timing, and what the view says after. */
async function act(d: Driver, raw: Record<string, unknown>, show?: (view: string) => string): Promise<string> {
  const a = normalizeAction(raw) as Action;
  const rating = await d.assess(a);
  console.log(`   ${JSON.stringify(raw)}  -> guard: ${rating.risk} (${rating.reason})`);
  if (rating.risk === "commit") {
    console.log("   refused here: rated commit");
    return "";
  }
  try {
    const note = await d.act(a);
    console.log(`   answer: ${note}`);
    console.log(`   timing: ${d.timing?.() ?? "(none)"}`);
    if (show) console.log(show(await d.look({ compact: true })));
    return note;
  } catch (e) {
    console.log(`   ERROR: ${(e as Error).message}`);
    return "";
  }
}

const near = (needle: RegExp, lines = 8) => (view: string) => {
  const all = view.split("\n");
  const i = all.findIndex((l) => needle.test(l));
  return i < 0 ? `   (nothing matches ${needle} in the view)` : all.slice(i, i + lines).map((l) => `   | ${l}`).join("\n");
};

async function screenNamed(d: Driver, what: string): Promise<{ id: string; kind: string } | undefined> {
  const s = (d as unknown as { screen(): never }).screen();
  const all = scrollables(s).map((x) => ({ id: x.id, kind: x.kind }));
  const hit = all.find((x) => x.kind === what);
  if (!hit) console.log(`   no ${what} on this screen (it has: ${all.map((x) => `${x.kind} ${x.id}`).join(", ") || "none"})`);
  return hit;
}

const checks: Record<string, (d: Driver) => Promise<void>> = {
  async wait(d) {
    if ((await pause("WAIT: Enter on the current screen")) === "skip") return;
    await act(d, { do: "key", key: 0 });
    if ((await pause(`WAIT: ${env.LIVE_REPORT ?? "/nVA05"}, then F8 (fill the selection by hand first if it needs it)`)) === "skip") return;
    await act(d, { do: "okcode", value: env.LIVE_REPORT ?? "/nVA05" });
    await pause("fill the selection screen if needed");
    await act(d, { do: "key", key: 8 }, near(/grid|list|table/));
    console.log("   CHECK: the answer came after the list was drawn, 'sap' is SAP's time, no 'has not answered'");
  },
  async cells(d) {
    if ((await pause("CELLS: put the cursor nowhere; a field must be on screen")) === "skip") return;
    const field = await rl.question("   field name to type into (e.g. VBAK-VBELN): ");
    await act(d, { do: "set", id: field.trim(), value: "1" });
    console.log("   CHECK: the text went into that field (look at SAP GUI); compare the point with the field");
    console.log(`   SAP_DIAG_CELL to calibrate by hand if it missed: "cw,ch,x0,y0"`);
  },
  async combo(d) {
    if ((await pause(`COMBO: ${env.LIVE_COMBO_TCODE ?? "(stay on this screen)"}`)) === "skip") return;
    if (env.LIVE_COMBO_TCODE) await act(d, { do: "okcode", value: env.LIVE_COMBO_TCODE });
    const id = env.LIVE_COMBO_ID ?? (await rl.question("   dropdown field name: ")).trim();
    await act(d, { do: "combo", id });
    const text = env.LIVE_COMBO_TEXT ?? (await rl.question("   text of an entry to choose: ")).trim();
    await act(d, { do: "combo", id, key: text }, near(new RegExp(id.replace(/[-[\]]/g, "."))));
    await act(d, { do: "key", key: 0 }, near(new RegExp(id.replace(/[-[\]]/g, "."))));
    console.log("   CHECK: the list opened on the click, typing found the entry, Enter took it; the key after Enter is the entry's");
  },
  async table(d) {
    if ((await pause(`TABLE: ${env.LIVE_TABLE_TCODE ?? "(open a screen with a table control of more than one page)"}`)) === "skip") return;
    if (env.LIVE_TABLE_TCODE) await act(d, { do: "okcode", value: env.LIVE_TABLE_TCODE });
    const t = env.LIVE_TABLE_ID ? { id: env.LIVE_TABLE_ID } : await screenNamed(d, "table");
    if (!t) return;
    for (const to of ["next", "prev", 12]) await act(d, { do: "scroll", id: t.id, to }, near(/table /, 4));
    await act(d, { do: "select", id: t.id, row: 12 });
    console.log("   CHECK: Page Down scrolled the table (not the screen), 'rows a to b' matches SAP GUI; the row selector of row 12 is marked");
  },
  async list(d) {
    if ((await pause(`LIST: ${env.LIVE_LIST_TCODE ?? "(open a classic list of several pages)"}`)) === "skip") return;
    if (env.LIVE_LIST_TCODE) await act(d, { do: "okcode", value: env.LIVE_LIST_TCODE });
    for (const to of ["next", "last", "first"]) await act(d, { do: "scroll", id: "list", to }, near(/^list /, 3));
  },
  async grid(d) {
    if ((await pause("GRID: open a screen with an ALV grid in a container (not full screen), more rows than fit")) === "skip") return;
    const g = await screenNamed(d, "grid");
    if (!g) return;
    await act(d, { do: "grid", id: g.id, row: 2, how: "cell" });
    console.log("   CHECK: the cursor is on row 2, first column");
    await act(d, { do: "grid", id: g.id, row: 3, how: "select" });
    console.log("   CHECK: row 3 is selected (row selector clicked)");
    await act(d, { do: "grid", id: g.id, row: 30, how: "select" });
    console.log("   CHECK: row 30 is selected (Shift+Space): if not, note it");
    await act(d, { do: "scroll", id: g.id, to: 40 }, near(/grid /, 3));
    await act(d, { do: "scroll", id: g.id, to: "next" });
    console.log("   CHECK: the grid scrolled; rows SAP had not sent came in the traffic (sap_look rows below)");
    console.log(await d.look({ compact: true, id: g.id, rows: { from: 40, to: 45 } }));
    if ((await pause("GRID: double-click row 1 (it may open a document: Back afterwards)")) === "skip") return;
    await act(d, { do: "grid", id: g.id, row: 1 });
  },
  async toolbar(d) {
    if ((await pause("TOOLBAR: a grid with its own toolbar on screen")) === "skip") return;
    const g = await screenNamed(d, "grid");
    if (!g) return;
    await act(d, { do: "toolbar", id: g.id, button: env.LIVE_TOOLBAR ?? "&SORT_ASC" });
    console.log("   CHECK: the button was found by name inside the grid and pressed; a full-screen ALV uses the screen's key instead");
  },
  async tree(d) {
    if ((await pause("TREE: a tree on screen (SAP Easy Access, or a document's header texts)")) === "skip") return;
    const t = await screenNamed(d, "tree");
    if (!t) return;
    console.log(await d.look({ compact: true, id: t.id, rows: { from: 0, to: 15 } }));
    const node = (await rl.question("   key of a closed folder (shown as {key}): ")).trim();
    await act(d, { do: "tree", id: t.id, node, how: "expand" }, near(/tree /, 12));
    await act(d, { do: "tree", id: t.id, node, how: "collapse" });
    console.log("   CHECK: Right opened the folder, Left closed it; the line counted from Home was the right node");
    const leaf = (await rl.question("   key of a node to open (double-click; it may start a transaction): ")).trim();
    await act(d, { do: "tree", id: t.id, node: leaf, how: "select" });
    await act(d, { do: "tree", id: t.id, node: leaf });
    console.log("   CHECK: Enter on the node opened it as a double-click does (a request went to SAP)");
  },
  async look(d) {
    if ((await pause("LOOK: a screen with a grid, a table control or a list longer than the screen")) === "skip") return;
    const s = (d as unknown as { screen(): never }).screen();
    const first = scrollables(s)[0];
    if (!first) return console.log("   nothing scrolls here");
    console.log(await d.look({ compact: true, id: first.id }));
    console.log(await d.look({ compact: true, id: first.id, rows: { from: 20, to: 35 } }));
  },
  async sessions() {
    if ((await pause("SESSIONS: open a second session (/o) and bring both to the same transaction")) === "skip") return;
    const all = await surface.discover();
    console.log(`   sessions: ${all.map((s) => `${s.id} "${s.title}"`).join(", ")}`);
    for (const info of all) {
      const d = await surface.open(info);
      await pause(`act in ${info.id} (put the OTHER window in front first)`);
      await act(d, { do: "key", key: 0 });
      console.log("   CHECK: Enter went to that session's window, not to the one in front");
    }
  },
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(checks);
console.log(`Router on 127.0.0.1:${env.SAP_DIAG_PORT ?? 3298}. Log on through it now (SAProuter string /H/127.0.0.1/S/${env.SAP_DIAG_PORT ?? 3298}...).`);
const info = await session();
console.log(`Session ${info.id}: ${info.title ?? ""}`);
const driver = await surface.open(info);
for (const name of wanted) {
  const check = checks[name];
  if (!check) {
    console.log(`unknown check ${name}: ${Object.keys(checks).join(", ")}`);
    continue;
  }
  console.log(`\n=== ${name}`);
  await check(driver);
}
rl.close();
process.exit(0);

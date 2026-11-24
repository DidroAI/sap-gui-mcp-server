import { describe, expect, test } from "bun:test";
import { diffViews, popupOver, sameScreen, whereLine } from "../src/core/diff.js";
import { Views, viewModeFromEnv } from "../src/core/views.js";

// A synthetic compact view: no SAP data.
const view = (over: { type?: string; status?: string; rows?: string[]; extra?: string[]; title?: string; screen?: string } = {}) =>
  [
    `TRANSACTION ZT01  PROGRAM ZPROG  SCREEN ${over.screen ?? "100"}  SYSTEM XYZ (100)`,
    `WINDOW wnd[0]  "${over.title ?? "Synthetic Order: Overview"}"`,
    "okcd  command-field",
    "btn[3]  button  Back (F3)",
    "btn[15]  button  Exit (Shift+F3)",
    `ctxtZHDR-TYPE  field  Order Type = "${over.type ?? ""}"  (edit)`,
    'ctxtZHDR-ORG  field  Sales Organization = "1000"  (edit)',
    'ctxtZHDR-CHAN  field  Distribution Channel = "10"  (edit)',
    'ctxtZHDR-DIV  field  Division = "00"  (edit)',
    "cntlGRID/shell  grid  40 rows; columns: A=Col A | B=Col B",
    ...(over.rows ?? ["  row 0: a | b", "  row 1: c | d", "  row 2: e | f", "  row 3: g | h"]),
    ...(over.extra ?? []),
    ...(over.status ? [`sbar  status  ${over.status}`] : []),
    "mbar  menubar  Order {menu[0]}, Edit {menu[1]}",
  ].join("\n");

const POPUP = [view({ type: "AB" }).split("\n").slice(0, 2).join("\n"), 'WINDOW wnd[1]  "Information"', "txtMESSTXT1  label  Something happened", "btn[0]  button  Continue (Enter)"].join("\n");

describe("sameScreen", () => {
  test("same header and windows, whatever the controls hold", () => {
    expect(sameScreen(view(), view({ type: "AB", status: "S: ok" }))).toBe(true);
  });
  test("another screen number, another title, a popup: not the same screen", () => {
    expect(sameScreen(view(), view({ screen: "200" }))).toBe(false);
    expect(sameScreen(view(), view({ title: "Synthetic Order: Item" }))).toBe(false);
    expect(sameScreen(view(), POPUP)).toBe(false);
  });
  test("popupOver: the same main window with more windows above", () => {
    expect(popupOver(POPUP, view())).toBe(true);
    expect(popupOver(view(), POPUP)).toBe(false);
    expect(popupOver(POPUP, view({ title: "Other" }))).toBe(false);
  });
});

describe("diffViews", () => {
  test("nothing changed", () => {
    expect(diffViews(view(), view()).text).toBe('NO CHANGE on ZT01 · "Synthetic Order: Overview" (15 lines; sap_look shows it).');
  });
  test("a changed line, a new line and a line that is gone", () => {
    const d = diffViews(view({ extra: ["lblOLD  label  Old"] }), view({ type: "AB", status: "E: Order type AB is not defined" }));
    expect(d.text.split("\n")).toEqual([
      'CHANGED 3 of 16 lines on ZT01 · "Synthetic Order: Overview" (same screen; sap_look shows all of it):',
      '~ ctxtZHDR-TYPE  field  Order Type = "AB"  (edit)',
      "+ sbar  status  E: Order type AB is not defined",
      "- lblOLD  label  Old",
    ]);
    expect(d.changed).toBe(3);
  });
  test("a few rows of a control changed: its line for context, then the rows", () => {
    const d = diffViews(view(), view({ rows: ["  row 0: a | b", "  row 1: c | CHANGED", "  row 2: e | f", "  row 3: g | h"] }));
    // The column list is in the view the agent holds: the context line leaves it out.
    expect(d.text.split("\n").slice(1)).toEqual(["= cntlGRID/shell  grid  40 rows; columns as before", "~   row 1: c | CHANGED"]);
  });
  test("a row that gets selected is a changed row", () => {
    const d = diffViews(view(), view({ rows: ["  row 0: a | b", "  row 1 (selected): c | d", "  row 2: e | f", "  row 3: g | h"] }));
    expect(d.text.split("\n").slice(1)).toEqual(["= cntlGRID/shell  grid  40 rows; columns as before", "~   row 1 (selected): c | d"]);
  });
  test("new rows come with the unchanged row before them, to say where they are", () => {
    const tree = (rows: string[]) => ["TRANSACTION Z  PROGRAM Z  SCREEN 1", 'WINDOW wnd[0]  "Tree"', "cntlT/shell  tree  3 nodes shown", ...rows].join("\n");
    const d = diffViews(tree(["  [+] A  {node 1}", "  [+] B  {node 2}", "  [+] C  {node 3}", "  [+] D  {node 4}", "  [+] E  {node 5}", "  [+] F  {node 6}"]), tree(["  [+] A  {node 1}", "  [-] B  {node 2}", "    B1  {node 21}", "  [+] C  {node 3}", "  [+] D  {node 4}", "  [+] E  {node 5}", "  [+] F  {node 6}"]));
    expect(d.text.split("\n").slice(1)).toEqual(["= cntlT/shell  tree  3 nodes shown", "~   [-] B  {node 2}", "+     B1  {node 21}"]);
  });
  test("most rows changed (a scroll): the control whole, as it is now", () => {
    const d = diffViews(view(), view({ rows: ["  row 20: u | v", "  row 21: w | x", "  row 22: y | z", "  row 23: 1 | 2"] }));
    expect(d.text.split("\n").slice(1)).toEqual(["~ cntlGRID/shell  grid  40 rows; columns: A=Col A | B=Col B", "    row 20: u | v", "    row 21: w | x", "    row 22: y | z", "    row 23: 1 | 2"]);
  });
});

describe("Views: what an action answers with", () => {
  test("the first view of a session is whole", () => {
    const v = new Views();
    expect(v.present("s", view())).toBe(view());
    expect(v.last("s")).toBe(view());
  });
  test("the same screen with a small change: the changes", () => {
    const v = new Views();
    v.present("s", view());
    expect(v.present("s", view({ type: "AB" }))).toBe('CHANGED 1 of 15 lines on ZT01 · "Synthetic Order: Overview" (same screen; sap_look shows all of it):\n~ ctxtZHDR-TYPE  field  Order Type = "AB"  (edit)');
    // Counted from the view just given, not from the first one.
    expect(v.present("s", view({ type: "AB" }))).toStartWith("NO CHANGE");
  });
  test("a new screen, a new transaction or a popup: always whole", () => {
    const v = new Views();
    v.present("s", view());
    expect(v.present("s", view({ screen: "200" }))).toBe(view({ screen: "200" }));
    expect(v.present("s", POPUP)).toBe(POPUP);
  });
  test("changes that are not much shorter than the view: the view", () => {
    const v = new Views();
    v.present("s", view());
    const all = view({ type: "X", rows: ["  row 9: 1 | 2"], status: "S: new" }).replace(/1000|"10"|"00"/g, '"9"');
    expect(v.present("s", all)).toBe(all);
  });
  test("a popup opened and closed: the changes since the screen below was last seen", () => {
    const v = new Views();
    v.present("s", view());
    v.present("s", POPUP);
    expect(v.present("s", view({ type: "AB" }))).toBe('CHANGED 1 of 15 lines on ZT01 · "Synthetic Order: Overview", back from the popup "Information" (since before it; same screen; sap_look shows all of it):\n~ ctxtZHDR-TYPE  field  Order Type = "AB"  (edit)');
  });
  test("back on a screen seen earlier, with another screen in between: whole", () => {
    const v = new Views();
    v.present("s", view());
    v.present("s", view({ screen: "200" }));
    expect(v.present("s", view())).toBe(view());
  });
  test("whole on request, in full mode, and per session", () => {
    const v = new Views();
    v.present("s", view());
    expect(v.present("s", view({ type: "AB" }), true)).toBe(view({ type: "AB" }));
    expect(v.present("other", view({ type: "AB" }))).toBe(view({ type: "AB" }));
    const full = new Views("full");
    full.present("s", view());
    expect(full.present("s", view({ type: "AB" }))).toBe(view({ type: "AB" }));
  });
  test("SAP_VIEW", () => {
    expect(viewModeFromEnv({})).toBe("diff");
    expect(viewModeFromEnv({ SAP_VIEW: " FULL " })).toBe("full");
    expect(() => viewModeFromEnv({ SAP_VIEW: "small" })).toThrow("SAP_VIEW must be diff or full");
  });
});

describe("fields that a message closed", () => {
  const ro = (v: string) => v.replace(/ {2}\(edit\)/g, "  (read-only)");

  test("four or more fields that only closed for input share one line; the message stays", () => {
    const d = diffViews(view({ type: "AB" }), ro(view({ type: "AB", status: "W: The date lies in the future" })));
    expect(d.text.split("\n")).toEqual([
      'CHANGED 5 of 16 lines on ZT01 · "Synthetic Order: Overview" (same screen; sap_look shows all of it):',
      "~ 4 fields closed for input (read-only now), values as before: ctxtZHDR-TYPE, ctxtZHDR-ORG, ctxtZHDR-CHAN, ...",
      "+ sbar  status  W: The date lies in the future",
    ]);
    expect(d.changed).toBe(5);
  });

  test("the fields open again in one line when the message is answered", () => {
    const d = diffViews(ro(view({ type: "AB", status: "W: The date lies in the future" })), view({ type: "AB" }));
    expect(d.text).toContain("~ 4 fields open for input again (edit), values as before: ctxtZHDR-TYPE, ctxtZHDR-ORG, ctxtZHDR-CHAN, ...");
    expect(d.text).toContain("- sbar  status  W: The date lies in the future");
  });

  test("an error leaves the wrong field open: it keeps its own line, with the cursor", () => {
    const next = ro(view({ type: "ZZ", status: "E: Type ZZ is not defined" })).replace('"ZZ"  (read-only)', '"ZZ"  (edit)  (cursor here)');
    const lines = diffViews(view({ type: "ZZ" }), next).text.split("\n");
    expect(lines).toContain('~ ctxtZHDR-TYPE  field  Order Type = "ZZ"  (edit)  (cursor here)');
    // Three fields closed: below the fold, each keeps its line.
    expect(lines).toContain('~ ctxtZHDR-ORG  field  Sales Organization = "1000"  (read-only)');
  });

  test("a field whose value changed too is not folded", () => {
    const next = ro(view({ type: "AB", status: "W: w" })).replace('"1000"', '"2000"');
    const lines = diffViews(view({ type: "AB" }), next).text.split("\n");
    expect(lines).toContain('~ ctxtZHDR-ORG  field  Sales Organization = "2000"  (read-only)');
    expect(lines.filter((l) => l.includes("closed for input"))).toEqual([]);
  });
});

describe("whereLine on a Fiori view", () => {
  test("the page title ends before its id", () => {
    expect(whereLine('FIORI\nPAGE Manage Orders (#app--page)\nbtn "Go"')).toBe('"Manage Orders"');
    expect(whereLine("FIORI\nPAGE Manage Orders")).toBe('"Manage Orders"');
  });
  test("a long title line full of ' (#' is read in linear time", () => {
    const t0 = performance.now();
    expect(whereLine(`FIORI\nPAGE x${" (#".repeat(50_000)}`)).toBe('"x"');
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

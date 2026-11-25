/**
 * The same screen sent again with only what changed (SAP's answer to a warning in FB50, 2026-11-25): the
 * fields come without their text (its length 0), closed for input, and SAP GUI keeps showing what they
 * held, the values the user typed and sent included. The reader showed them as empty read-only fields, and
 * the agent typed the header again into fields SAP had closed. Now a field sent without its text keeps the
 * text it had, and the values SAP GUI sends with a request are what the fields hold.
 */
import { describe, expect, test } from "bun:test";
import { DiagDecoder } from "../../src/diag/decoder.js";
import type { DiagScreen } from "../../src/diag/screen.js";
import { areaLevel, areaName, elem, elementList, END, message, RESET, screenHead, sessionInfo, tabList, tabstripHeader, windowStart } from "./build.js";

const first = message([
  ...screenHead({ tcode: "FB50", program: "SAPMF05A", dynpro: "1001", title: "Enter G/L Account Document" }),
  RESET,
  areaLevel(3, 1, 0, 80, 8),
  areaLevel(8, 0, 0, 66, 11),
  areaName("TABSTRIP_HEAD", "SAPMF05A", "1001"),
  tabstripHeader("TABSTRIP_HEAD", "TAB1", 2),
  tabList(elem.tab(0, "Basic Data", "TAB1", true), elem.tab(1, "Details", "TAB2")),
  RESET,
  areaLevel(3, 1, 0, 80, 8),
  elementList(elem.label(2, 1, "Document Date"), elem.field(2, 17, "", { width: 10 }), elem.name(2, 17, "ACGL_HEAD-BLDAT"), elem.label(5, 1, "Doc.Header Text"), elem.field(5, 17, "", { width: 25 }), elem.name(5, 17, "ACGL_HEAD-BKTXT"), elem.field(6, 17, "1000", { width: 4, output: true }), elem.name(6, 17, "ACGL_HEAD-BUKRS")),
  END,
]);

/** SAP GUI's request: the values typed, in the same areas. */
const typed = message([RESET, areaLevel(3, 1, 0, 80, 8), elementList(elem.field(2, 17, "25.11.2026", { width: 10 }), elem.field(5, 17, "BTP2SZP1", { width: 25 }))], { info: 0 });

/** The update: fields closed and sent without their text, one field with a new text, and a warning. */
const update = (bukrs?: string) =>
  message([
    windowStart({ rows: 20, cols: 100, update: true }),
    RESET,
    areaLevel(8, 0, 0, 66, 11),
    areaName("TABSTRIP_HEAD", "SAPMF05A", "1001"),
    tabstripHeader("TABSTRIP_HEAD", "TAB1", 2),
    RESET,
    areaLevel(3, 1, 0, 80, 8),
    elementList(elem.unsent(2, 1, 13, { label: true }), elem.unsent(2, 17, 10, { readOnly: true }), elem.name(2, 17, "ACGL_HEAD-BLDAT"), elem.unsent(5, 1, 15, { label: true }), elem.unsent(5, 17, 25, { readOnly: true }), elem.name(5, 17, "ACGL_HEAD-BKTXT"), bukrs === undefined ? elem.unsent(6, 17, 4, { readOnly: true }) : elem.field(6, 17, bukrs, { width: 4, output: true }), elem.name(6, 17, "ACGL_HEAD-BUKRS")),
    sessionInfo(0x0b, "W: G/L account 476000 is relevant to tax; check code"),
    END,
  ]);

function run(frames: [0 | 1, Buffer][]): DiagScreen[] {
  const d = new DiagDecoder();
  const out: DiagScreen[] = [];
  d.onScreen = (s) => out.push(s);
  for (const [dir, f] of frames) d.push(dir, f);
  return out;
}
const field = (s: DiagScreen | undefined, name: string) => s?.windows[0]?.elements.find((e) => e.name === name);

describe("fields SAP sends again without their text", () => {
  test("keep what they held, the values SAP GUI sent included, and are closed as SAP says", () => {
    const screens = run([[1, first], [0, typed], [1, update()]]);
    const s = screens[screens.length - 1];
    expect(s?.message?.text).toContain("relevant to tax");
    expect(field(s, "ACGL_HEAD-BLDAT")).toMatchObject({ text: "25.11.2026", input: false });
    expect(field(s, "ACGL_HEAD-BKTXT")).toMatchObject({ text: "BTP2SZP1", input: false });
    expect(field(s, "ACGL_HEAD-BUKRS")).toMatchObject({ text: "1000", input: false });
    expect(s?.windows[0]?.elements.find((e) => e.kind === "label" && e.row === 3)?.text).toBe("Document Date");
  });
  test("a tabstrip sent again without its tabs keeps them", () => {
    const screens = run([[1, first], [0, typed], [1, update()]]);
    const strips = screens[screens.length - 1]?.windows[0]?.tabstrips ?? [];
    expect(strips.map((t) => [t.name, t.tabs.map((x) => `${x.text}${x.active ? "*" : ""}`)])).toEqual([["TABSTRIP_HEAD", ["Basic Data*", "Details"]]]);
  });
  test("a text SAP does send replaces the one held", () => {
    const screens = run([[1, first], [0, typed], [1, update("2000")]]);
    expect(field(screens[screens.length - 1], "ACGL_HEAD-BUKRS")?.text).toBe("2000");
  });
  test("a screen sent whole takes the texts as sent: empty is empty", () => {
    const screens = run([[1, first], [0, typed], [1, first]]);
    expect(field(screens[screens.length - 1], "ACGL_HEAD-BLDAT")).toMatchObject({ text: "", input: true });
  });
});

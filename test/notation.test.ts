import { describe, expect, test } from "bun:test";
import { dateFormatOf, decimalOf, hasPointOrComma, notationIn, notationNote, withNumbers } from "../src/core/notation.js";
import { notationOfCodes } from "../src/fiori/driver.js";

const COMMA = ['wnd[0]/usr/txtNETWR  field  Net value = "1.250,00"  (read-only)', "wnd[0]/usr/tbl  table  rows 3; selected rows 0,7", "  row 0: Item=10; Quantity=1,000"].join("\n");
const POINT = ["wnd[0]/usr/cntlG/shell  grid  2 rows; columns: A=Amount | B=Curr.", "  row 0: 422.94 | USD", "  row 1: 1,193.50 | USD"].join("\n");

test("the screen tells the decimal sign by an amount it shows (ECCSCR-10)", () => {
  expect(decimalOf(COMMA)).toEqual({ sign: ",", example: "1.250,00" });
  expect(decimalOf(POINT)).toEqual({ sign: ".", example: "422.94" });
  // Nothing that is clearly an amount: nothing is said. "selected rows 0,7" and a quantity "1,000" are not evidence.
  expect(decimalOf('wnd[0]/usr/ctxtA  field  Type = "OR"  (edit)\n  row 0: Item=10; Quantity=1,000')).toBeUndefined();
  expect(decimalOf(`${COMMA}\n${POINT}`)).toBeUndefined();
});

test("a typed number that reads differently in the user's notation gets a note", () => {
  expect(notationNote("1.000", COMMA)).toBe('numbers on this screen have a decimal comma, e.g. "1.250,00": if this field is a number, "1.000" is read as 1000');
  expect(notationNote("1.5", COMMA)).toBe('numbers on this screen have a decimal comma, e.g. "1.250,00": if this field is a number, "1.5" is not a number in that notation (1,5 is)');
  expect(notationNote("1,234.50", COMMA)).toContain("(1234,50 is)");
  expect(notationNote("1,000", POINT)).toContain('"1,000" is read as 1000');
  for (const fine of ["1,5", "1.000,00", "1000", "17.11.2026", "M-17", "OR", "10"]) expect(notationNote(fine, COMMA)).toBeUndefined();
  expect(notationNote("1.5", POINT)).toBeUndefined();
  expect(notationNote("1.5", 'wnd[0]/usr/ctxtA  field  Type = "OR"  (edit)')).toBeUndefined();
});

describe("the session's notation, on every answer that shows such a number (P1)", () => {
  const MB51 = [
    "TRANSACTION MB51  PROGRAM RM07DOCS  SCREEN 120",
    'WINDOW wnd[0]  "Material Document List"',
    "cntlGRID1/shell  grid  3 rows; columns: BWART=MvT | MENGE=Qty | MEINS=EUn",
    "  row 0: 561 | 1.000 | PC",
    "  row 1: 561 | 1- | PC",
  ].join("\n");
  test("a number with a point or a comma; not a date, an id or a plain number", () => {
    expect(hasPointOrComma(MB51)).toBe(true);
    expect(hasPointOrComma("  [-] Full | 312,000 | | 100,000  {node 1}")).toBe(true);
    expect(hasPointOrComma('ctxtA  field  Date = "31.03.2015"\n  row 0: 4711 | 10 | PC')).toBe(false);
    expect(hasPointOrComma("usr  list  (cell ids: usr/lbl[col,row]; columns 1,6,11,20)")).toBe(false);
  });
  test("what a screen tells: its NUMBERS line, its amounts, its dates", () => {
    expect(notationIn('NUMBERS 1.234,56  (decimal comma: ...)')).toEqual({ sign: ",", spaced: false, from: "screen" });
    expect(notationIn('~ txtA  field  Net = "87.75"  (read-only)')).toEqual({ sign: ".", spaced: false, from: "screen" });
    expect(notationIn(MB51)).toBeUndefined();
    expect(dateFormatOf('ctxtA  field  Date = "11/23/2026"\n  row 0: 4711 | 03/12/2018')).toBe("MM/DD/YYYY");
    expect(dateFormatOf('ctxtA  field  Date = "23.11.2026"')).toBe("DD.MM.YYYY");
    expect(dateFormatOf("nothing")).toBeUndefined();
  });
  test("a known notation goes under the header; an unknown one says so and where to find it", () => {
    const known = withNumbers(MB51, { sign: ",", date: "DD.MM.YYYY", from: "screen" }).split("\n");
    expect(known[1]).toStartWith('NUMBERS 1.234,56  (decimal comma: "1.000" is one thousand');
    expect(known[1]).toEndWith("; as seen on an earlier screen; dates DD.MM.YYYY)");
    const unknown = withNumbers(MB51, undefined).split("\n");
    expect(unknown[1]).toStartWith("NUMBERS unknown");
    expect(unknown[1]).toContain("SU3");
    // A read of rows has no header: the line comes first. A diff has its CHANGED line.
    expect(withNumbers("cntlGRID1/shell  grid  3 rows\n  row 0: 1.000", { sign: "." }).split("\n")[0]).toStartWith("NUMBERS 1,234.56");
    expect(withNumbers('CHANGED 1 of 9 lines on MB51\n~ txtA  field  Qty = "1.000"', { sign: "," }).split("\n")[1]).toStartWith("NUMBERS 1.234,56");
    // The answer says it already, or shows no such number: left as it is.
    expect(withNumbers(`${MB51}\nNUMBERS 1,234.56  (x)`, { sign: "," })).toBe(`${MB51}\nNUMBERS 1,234.56  (x)`);
    expect(withNumbers("TRANSACTION X\n  row 0: 4711", undefined)).toBe("TRANSACTION X\n  row 0: 4711");
  });
  test("the user's settings in SAP's codes", () => {
    expect(notationOfCodes("X", "2")).toEqual({ sign: ".", date: "MM/DD/YYYY" });
    expect(notationOfCodes(" ", "1")).toEqual({ sign: ",", date: "DD.MM.YYYY" });
    expect(notationOfCodes("Y", null)).toEqual({ sign: ",", spaced: true });
    expect(notationOfCodes(null, null)).toBeUndefined();
  });
});

describe("quantities with three decimals, and tree nodes (MMBE, live 2026-11-25: NUMBERS unknown)", () => {
  test("a comma after grouped thousands is a decimal comma, whatever the decimals", () => {
    expect(decimalOf('x  field  Q = "9.983,000"')?.sign).toBe(",");
    expect(decimalOf('x  field  Q = "9,983.000"')?.sign).toBe(".");
    // Still ambiguous alone: 40,000 and 1.000.
    expect(decimalOf('x  field  Q = "40,000"')).toBeUndefined();
    expect(decimalOf('x  field  Q = "1.000"')).toBeUndefined();
  });
  test("the nodes of a column tree tell it", () => {
    const view = "shell[1]  tree  9 nodes shown; columns: Plant | Unrestricted use\n  [-] Full | 9.983,000  {node 1}\n    0001 Materiallager | 9.815,000  {node 5}";
    expect(decimalOf(view)?.sign).toBe(",");
    expect(notationIn(view)?.sign).toBe(",");
  });
});

import { expect, test } from "bun:test";
import { decimalOf, notationNote } from "../src/core/notation.js";

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

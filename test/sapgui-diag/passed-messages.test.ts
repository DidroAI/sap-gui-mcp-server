/**
 * A step whose answer goes through more than one screen keeps the messages of the screens before the
 * last: FB50's Save (2026-11-25) answered "S: Document 100000006 was posted in company code 1000", and SAP
 * GUI went on at once to the empty entry screen, "E: Enter valid date". The agent saw only the error,
 * thought nothing was posted, and posted the document again.
 */
import { describe, expect, test } from "bun:test";
import { passedMessages } from "../../src/sapgui-diag/index.js";

const kept = [
  { step: 7, line: "sbar  status  W: G/L account 476000 is relevant to tax; check code  (FS 219)" },
  { step: 9, line: "sbar  status  S: Document 100000006 was posted in company code 1000  (F5 312)" },
  { step: 10, line: "sbar  status  E: Enter valid date  (F5 114)" },
];

describe("messages of the screens a step went through", () => {
  test("those after the step began and before its last screen, once each", () => {
    expect(passedMessages(kept, 8, "sbar  status  E: Enter valid date  (F5 114)")).toEqual(["SAP also showed, on a screen this step went through: S: Document 100000006 was posted in company code 1000  (F5 312)"]);
  });
  test("nothing when the step had one screen", () => {
    expect(passedMessages(kept, 9, "sbar  status  E: Enter valid date  (F5 114)")).toEqual([]);
    expect(passedMessages([], 0, undefined)).toEqual([]);
  });
});

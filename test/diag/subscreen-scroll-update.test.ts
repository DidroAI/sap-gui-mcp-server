/**
 * XD01's address tab scrolls on its own. Live 2026-11-26: after the wheel and Enter, SAP answered with an update
 * (only what changed): the fields at their new rows, the labels not sent again. The labels and frames were kept
 * at their old rows beside the fields at the new ones (the language twice, the country under "Name"). Kept
 * elements of a container that moved now move with it, and are marked scrolled out of view where they leave it.
 */
import { describe, expect, test } from "bun:test";
import { DiagDecoder } from "../../src/diag/decoder.js";
import { diagView } from "../../src/diag/view.js";
import { areaLevel, areaName, elem, elementList, END, message, RESET, screenHead, scrollState, windowStart } from "./build.js";

const page = (first: number, update: boolean, labels: boolean) =>
  message([
    ...(update ? [windowStart({ rows: 20, cols: 100, update: true })] : screenHead({ tcode: "XD01", program: "SAPMF02D", dynpro: "7000", title: "Create Customer: General Data" })),
    RESET,
    areaLevel(3, 4, 0, 90, 6),
    areaName("ADDRESS", "SAPLSZA1", "0300"),
    scrollState(14, 90, first, 0, 6, 90),
    elementList(
      ...(labels ? [elem.label(2, 1, "Name")] : []),
      elem.field(2, 22, "", { width: 20 }),
      elem.name(2, 22, "ADDR1_DATA-NAME1"),
      ...(labels ? [elem.label(12, 1, "Language")] : []),
      elem.field(12, 22, "EN", { width: 2 }),
      elem.name(12, 22, "ADDR1_DATA-LANGU"),
    ),
    END,
  ]);

describe("an update after a subscreen scrolled", () => {
  test("kept labels move with the container, and scroll out of view with it", () => {
    const d = new DiagDecoder();
    d.push(1, page(0, false, true));
    let v = diagView(d.screen() as never).split("\n");
    expect(v).toContain('r6  Name  ADDR1_DATA-NAME1@22=[]');
    expect(v).toContain('r16 (scrolled out of view)  Language  ADDR1_DATA-LANGU@22=[EN]');
    d.push(1, page(8, true, false));
    v = diagView(d.screen() as never).split("\n");
    expect(v).toContain('r8  Language  ADDR1_DATA-LANGU@22=[EN]');
    expect(v).toContain('r-2 (scrolled out of view)  Name  ADDR1_DATA-NAME1@22=[]');
    expect(v.filter((l) => l.includes("Language"))).toHaveLength(1);
  });
});

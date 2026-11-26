/**
 * A classic list (ME2L, FBL5N) says with each page the line it starts at: ME2L's 54 lines came as pages
 * from 0, 25 and 50 (captured 2026-11-25). The decoder read only the count, so every page looked like
 * the first: a scroll answered "did not move with SAP's page key" while the list had moved, and a look
 * with rows never got past the first page (S/4's P2P-05: 26 steps against scripting's 4).
 */
import { describe, expect, test } from "bun:test";
import { DiagDecoder } from "../../src/diag/decoder.js";
import { position } from "../../src/sapgui-diag/plan.js";
import { END, listCell, listHead, message, screenHead } from "./build.js";

const page = (first: number) => message([...screenHead({ tcode: "ME2L", program: "RM06EL00", dynpro: "0120" }), ...listHead(54, first, 25), ...listCell(1, 1, "PO"), ...listCell(3, 1, `line ${first}`), ...listCell(4, 1, `line ${first + 1}`), END]);

describe("a classic list's page", () => {
  test("the first line on show and the lines on show are read", () => {
    const d = new DiagDecoder();
    d.push(1, page(25));
    const list = d.screen()?.windows[0]?.list;
    expect(list).toMatchObject({ totalRows: 54, firstRow: 25, visibleRows: 25 });
    expect(position({ kind: "list", window: d.screen()?.windows[0] as never, id: "list" })).toEqual({ first: 25, visible: 25, total: 54 });
  });
  test("the next page moves it", () => {
    const d = new DiagDecoder();
    d.push(1, page(0));
    expect(d.screen()?.windows[0]?.list?.firstRow).toBe(0);
    d.push(1, page(50));
    expect(d.screen()?.windows[0]?.list?.firstRow).toBe(50);
  });
});

describe("the view of a list's later page", () => {
  test("says the line it starts at", async () => {
    const { diagView } = await import("../../src/diag/view.js");
    const d = new DiagDecoder();
    d.push(1, page(25));
    expect(diagView(d.screen() as never).split("\n")).toContain("list  54 rows, 3 on show from line 25");
  });
});

/**
 * A table control scrolled sideways (FB50's items after the cursor moved right, 2026-11-25): SAP's scroll
 * item names the first column on show after the fixed ones (9, Assignment), and the table's description
 * the fixed columns (5: Status to Amount, left of SAP GUI's divider). The fixed ones stay where they were;
 * the others start at that column; those between are out of view.
 */
import { describe, expect, test } from "bun:test";
import { layoutColumns } from "../../src/diag/classic.js";
import type { DiagTable } from "../../src/diag/screen.js";

const widths = [1, 10, 10, 7, 17, 16, 2, 15, 1, 18, 10, 10, 3, 4, 6, 4, 4, 1, 10];
const table = (first?: number) =>
  ({ name: "TABLE", program: "SAPLFSKB", title: "", row: 11, col: 1, width: 120, height: 8, columns: widths.map((w, i) => ({ index: i, position: i, name: `C${i}`, title: `T${i}`, width: w, col: 0, visible: false })), rows: [], fixedColumns: 5, ...(first ? { firstColumn: first } : {}), path: [] }) as unknown as DiagTable;
const shown = (t: DiagTable) => t.columns.filter((c) => c.visible).map((c) => `${c.name}@${c.col}`);

describe("columns of a table control scrolled sideways", () => {
  test("not scrolled: from the left edge, as far as the table's width", () => {
    const t = table();
    layoutColumns(t);
    expect(shown(t)).toEqual(["C0@3", "C1@5", "C2@16", "C3@27", "C4@35", "C5@53", "C6@70", "C7@73", "C8@89", "C9@91", "C10@110"]);
  });
  test("scrolled to column 9: the fixed five, then 9 on", () => {
    const t = table(9);
    layoutColumns(t);
    expect(shown(t)).toEqual(["C0@3", "C1@5", "C2@16", "C3@27", "C4@35", "C9@53", "C10@72", "C11@83", "C12@94", "C13@98", "C14@103", "C15@110", "C16@115", "C17@120"]);
  });
});

/**
 * The compact view of an SAP screen, from the full view.
 *
 * The SAP GUI reader and the Web GUI reader produce the same full format: a
 * header line, a `WINDOW` line per window, then one control per line,
 * `<scripting id>  <type>  <label and value>  <state>`. This one function
 * shortens both:
 * - ids are cut to their last segment when that segment is unique on the
 *   screen (actions accept the short id);
 * - a table control's cells become one line per row, with only the cells
 *   that hold a value; checkboxes in tables appear when checked.
 */

const CELL = /^(?<tbl>.*\/tbl[^/[]+)\/(?<ctl>[a-z]+)(?<name>[^[\s]+)\[(?<c>\d+),(?<r>\d+)\]\s+(?<rest>.*)$/;

/** The id of a control line: everything before the first two spaces. */
const idOf = (line: string): string => line.split("  ", 1)[0] ?? "";
const lastSegment = (id: string): string => id.slice(id.lastIndexOf("/") + 1);

type Out = string | { row: string; tbl: string; r: number };

export function compact(full: string): string {
  const lines = full.split("\n");
  const last = new Map<string, number>();
  for (const l of lines) {
    if (!l.startsWith("wnd[")) continue;
    const seg = lastSegment(idOf(l));
    last.set(seg, (last.get(seg) ?? 0) + 1);
  }
  const titles = new Map<string, string[]>();
  const rows = new Map<string, string[]>();
  const out: Out[] = [];
  for (const l of lines) {
    const g = CELL.exec(l)?.groups;
    if (g) {
      const tbl = g.tbl ?? "";
      const rest = g.rest ?? "";
      const c = Number(g.c);
      const r = Number(g.r);
      const col = titles.get(tbl)?.[c] || (g.name ?? "");
      let cell: string | null = null;
      if (rest.startsWith("checkbox")) cell = rest.includes("[x]") ? `${col} [x]` : null;
      else {
        const v = /= "(.*)" {2}\((edit|read-only)\)/.exec(rest);
        cell = v?.[1] ? `${col}=${v[1]}` : null;
      }
      const key = `${tbl}|${r}`;
      let cells = rows.get(key);
      if (!cells) {
        cells = [];
        rows.set(key, cells);
        out.push({ row: key, tbl, r });
      }
      if (cell) cells.push(cell);
      continue;
    }
    if (l.includes(" table  rows ")) {
      const tbl = idOf(l);
      titles.set(
        tbl,
        l.includes("columns: ")
          ? (l.split("columns: ")[1] ?? "").split(" | ").map((x) => x.replace(/^ +| +$/g, ""))
          : [],
      );
      const short = lastSegment(tbl);
      out.push(`${short}  table  ${l.split("  table  ")[1]}  (cell ids: <field>[col,row], e.g. ${short}/<ctl><FIELD>[0,0])`);
      continue;
    }
    if (l.startsWith("wnd[")) {
      const i = idOf(l);
      const rest = l.slice(i.length + 2);
      const seg = lastSegment(i);
      const unique = last.get(seg) === 1 && seg !== "" && !/^(btn\[|shell|menu\[)/.test(seg);
      const short = unique ? seg : i.includes("/usr/") ? i.slice(i.indexOf("/usr/") + 5) : i;
      out.push(`${short}  ${rest}`);
      continue;
    }
    out.push(l);
  }
  return out
    .map((x) => (typeof x === "string" ? x : `  ${lastSegment(x.tbl)} row ${x.r}: ${(rows.get(x.row) ?? []).join("; ") || "(empty)"}`))
    .join("\n");
}

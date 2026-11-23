/**
 * Labels that SAP draws apart from their field, merged into the field's line.
 *
 * ECC's Web GUI ties a label to its field, and the field's line carries the
 * label the user sees: `ctxtVBAK-AUART  field  Order Type = "OR"`. S/4HANA's
 * Web GUI draws the label as a control of its own, and the field's line
 * carries the dictionary text, often a bare "Description":
 *
 *   lblVBUK-CMGST  label  OverallCredStat
 *   txtVBSTT-CMGST_BEZ  field  Description = "Not Performed"  (read-only)
 *
 * Without the label line the field says nothing; with it the screen is much
 * longer. Here the label goes into the field's line, as on ECC, and its own
 * line goes:
 *
 *   txtVBSTT-CMGST_BEZ  field  OverallCredStat = "Not Performed"  (read-only)
 *
 * - A selection screen's texts (`txt%_SAUART_%_APP_%-TEXT`, `...-TO_TEXT`)
 *   belong to the field they name (SAUART-LOW, SAUART-HIGH, a parameter).
 * - Any other label belongs to the field on the line right after it, in the
 *   same container. A label in front of several fields ("Street/House
 *   Number" before Street and House Number) names the first only where that
 *   field's own text says nothing like it; its line goes either way.
 * - A label with the field's own text is dropped.
 */

const LABEL = /^(\S+) {2}label {2}(.+)$/;
const FIELD = /^(\S+) {2}(field|dropdown) {2}(.*?)( ?= ".*)$/;
/** A selection screen's text: the field it names, and whether it is the "to" of an interval. */
const SELECTION_TEXT = /^txt%_(.+?)_%_APP_%-(TEXT|TO_TEXT)$/;

const parent = (id: string) => id.slice(0, id.lastIndexOf("/") + 1);
const last = (id: string) => id.slice(id.lastIndexOf("/") + 1);
/** A field's name without its type prefix: ctxtSAUART-LOW -> SAUART-LOW. */
const nameOf = (id: string) => last(id).replace(/^(ctxt|txt|cmb|pwd)/, "");
/** A table cell (…[col,row]) is not a field a label stands in front of. */
const isCell = (id: string) => /\[\d+,\d+\]$/.test(id);

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9äöüß]+/).filter((w) => w.length > 1);
/** Do two texts say something alike: a word in common, or words that start the same (Valid / Validity)? */
function alike(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  return x.some((p) => y.some((q) => p === q || (p.length >= 4 && q.length >= 4 && p.slice(0, 4) === q.slice(0, 4))));
}

/** The field line with `label` as its label. */
function relabel(line: string, label: string): string {
  const m = FIELD.exec(line);
  if (!m) return line;
  return `${m[1]}  ${m[2]}  ${label}${(m[4] ?? "").startsWith(" ") ? m[4] : ` ${m[4]}`}`;
}

/** The lines of one window with each label that stands apart from its field merged into that field's line. */
export function mergeLabels(lines: string[]): string[] {
  const out = [...lines];
  const gone = new Set<number>();
  const fieldAt = (i: number) => {
    const m = FIELD.exec(out[i] ?? "");
    return m && !isCell(m[1] ?? "") ? m : undefined;
  };
  // A selection screen's texts first: their field is found by its name, wherever it stands.
  for (let i = 0; i < out.length; i++) {
    const l = LABEL.exec(out[i] ?? "");
    if (!l) continue;
    const id = l[1] ?? "";
    const text = (l[2] ?? "").trim();
    const sel = SELECTION_TEXT.exec(last(id));
    if (!sel) continue;
    const names = sel[2] === "TO_TEXT" ? [`${sel[1]}-HIGH`] : [`${sel[1]}-LOW`, sel[1]];
    for (const name of names) {
      const at = out.findIndex((x, j) => {
        const f = fieldAt(j);
        return !!f && !gone.has(j) && parent(f[1] ?? "") === parent(id) && nameOf(f[1] ?? "") === name;
      });
      if (at < 0) continue;
      out[at] = relabel(out[at] ?? "", text);
      gone.add(i);
      break;
    }
  }
  for (let i = 0; i < out.length - 1; i++) {
    if (gone.has(i)) continue;
    const l = LABEL.exec(out[i] ?? "");
    if (!l || SELECTION_TEXT.test(last(l[1] ?? ""))) continue;
    const text = (l[2] ?? "").trim();
    // An icon drawn as a label ("icon \"Select: Not equal to\"") is not a field's name.
    if (!text || text.startsWith("icon ")) continue;
    const f = fieldAt(i + 1);
    if (!f || parent(f[1] ?? "") !== parent(l[1] ?? "")) continue;
    const own = (f[3] ?? "").trim();
    if (own.toLowerCase() === text.toLowerCase()) {
      gone.add(i);
      continue;
    }
    // A label in front of several fields: the first keeps a text of its own that says what it is.
    const next = fieldAt(i + 2);
    const shared = !!next && parent(next[1] ?? "") === parent(l[1] ?? "");
    if (!(shared && own && alike(own, text))) out[i + 1] = relabel(out[i + 1] ?? "", text);
    gone.add(i);
  }
  return out.filter((_, i) => !gone.has(i));
}

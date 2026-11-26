/**
 * The decimal notation of the SAP user, as far as a screen shows it.
 *
 * SAP reads a typed number in the user's notation (user profile, decimal
 * notation): with a decimal comma "1.000" is one thousand and "1.5" is an
 * error. No surface is told the notation; the screen shows it whenever it
 * holds an amount ("1.250,00"). So when an agent types a value that reads
 * differently in the other notation, the answer says which one the screen
 * uses. A screen without such a number says nothing, and neither does this.
 *
 * Reading has the same trap ("1.000" is a thousand with a decimal comma, one
 * with a point; "312,000" is 312 with a comma): the compact view says the
 * notation once, under its header (`numbersLine`).
 */

/**
 * "1.250,00", "0,00", "1 250,5-": groups of three with a point or a space, a comma, one or two decimals;
 * or any number of decimals after a group with a point ("9.983,000", a quantity on MMBE): a comma
 * after a point is a decimal comma in every notation.
 */
const DECIMAL_COMMA = /^-?(?:\d{1,3}(?:[. ]?\d{3})*,\d{1,2}|\d{1,3}(?:\.\d{3})+,\d+)-?$/;
/** "1,250.00", "0.00"; "9,983.000". */
const DECIMAL_POINT = /^-?(?:\d{1,3}(?:[, ]?\d{3})*\.\d{1,2}|\d{1,3}(?:,\d{3})+\.\d+)-?$/;

/** The values a view shows: what stands in quotes, and the cells of rows (a list's cells without their column in braces). */
function valuesOf(view: string): string[] {
  const out: string[] = [];
  for (const line of view.split("\n")) {
    if (/^\s+row \d+/.test(line)) {
      for (const cell of line.replace(/^\s+row \d+[^:]*: /, "").split(/ \| |; /))
        out.push(
          cell
            .replace(/^[^=|]*=/, "")
            .replace(/ \{\d+\}$/, "")
            .replace(/^ +| +$/g, ""),
        );
      continue;
    }
    const q = /= "([^"]*)"/.exec(line);
    if (q?.[1]) out.push(q[1]);
  }
  return out;
}

/** The decimal sign the numbers of a view use, with one of them as the example; undefined when the view does not tell. */
export function decimalOf(view: string): { sign: "," | "."; example: string } | undefined {
  let comma: string | undefined;
  let point: string | undefined;
  // Tree nodes count too (MMBE's stock is a column tree: "1000 Hamburg | 9.983,000").
  for (const v of [...valuesOf(view), ...valuesIn(view)]) {
    if (!comma && DECIMAL_COMMA.test(v)) comma = v;
    else if (!point && DECIMAL_POINT.test(v)) point = v;
  }
  // Both on one screen (a text that looks like a number): nothing is said.
  if (comma && !point) return { sign: ",", example: comma };
  if (point && !comma) return { sign: ".", example: point };
  return undefined;
}

/**
 * What to tell an agent that types `value` on the screen `view` shows:
 * undefined when the value reads the same in both notations, or the screen
 * does not show which one the user has.
 */
export function notationNote(value: string, view: string): string | undefined {
  const v = value.replace(/^\s+|\s+$/g, "");
  // A number with a point or a comma in it; a date (17.11.2026) is not one.
  if (!/^-?\d[\d.,]*\d-?$/.test(v) || !/[.,]/.test(v) || /^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/.test(v)) return undefined;
  const shown = decimalOf(view);
  if (!shown) return undefined;
  const other = shown.sign === "," ? "." : ",";
  // Written in the screen's notation already: its last sign is the decimal sign, or it has only correct groups.
  const last = v[Math.max(v.lastIndexOf("."), v.lastIndexOf(","))];
  if (last === shown.sign) return undefined;
  const name = shown.sign === "," ? "a decimal comma" : "a decimal point";
  const groups = new RegExp(`^-?\\d{1,3}(?:\\${other}\\d{3})+-?$`).test(v);
  const digits = v.split(other).join("");
  const reads = groups
    ? `"${v}" is read as ${digits}`
    : `"${v}" is not a number in that notation (${v.split(shown.sign).join("").replace(other, shown.sign)} is)`;
  return `numbers on this screen have ${name}, e.g. "${shown.example}": if this field is a number, ${reads}`;
}

/**
 * The line under the header of the compact view that says how numbers are
 * written: "NUMBERS 1.234,56  (decimal comma: ...)". `example` (a number of
 * the screen) tells a grouping by spaces ("1 234,56") from one by points.
 */
export function numbersLine(sign: "," | ".", example?: string): string {
  if (sign === ".") return 'NUMBERS 1,234.56  (decimal point: "1,000" is one thousand, "1.000" is one)';
  const spaced = example !== undefined && /\d \d{3}/.test(example);
  return `NUMBERS ${spaced ? "1 234,56" : "1.234,56"}  (decimal comma: "1.000" is one thousand, "1,000" is one, "312,000" is 312)`;
}

/**
 * What the server knows of a session's notation: the decimal sign (and a
 * grouping by spaces), and the date format, from the user's settings when
 * the surface can read them, else from screens seen before. SAP shows a
 * user's numbers and dates the same way on every screen, so a notation seen
 * once holds for the screens that do not show it (MB51's "1.000", MMBE's
 * "312,000": no amount with decimals there, and agents read 1 and 312000).
 */
export interface Notation {
  sign?: "," | ".";
  /** Groups of three are separated by spaces ("1 234,56"). */
  spaced?: boolean;
  /** "DD.MM.YYYY", "MM/DD/YYYY", ...: how the user types and reads dates. */
  date?: string;
  /** Where it was learnt: the user's settings, or a screen. */
  from?: "settings" | "screen";
}

/** A diff answer's mark before a line ("~ ", "+ ", "- ", "= "). */
const MARK = /^[~+=-] /;

/** The values a text shows: quoted values, and the cells of rows, tree nodes and lists (" | " or "; " between them). */
function valuesIn(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(MARK, "");
    for (const m of line.matchAll(/"([^"]*)"/g)) if (m[1]) out.push(m[1]);
    const row = /^\s+(?:row|title) \d+[^:]*: (.*)$/.exec(line)?.[1] ?? (/^\s+(?:\[[+-]\] )?\S.* \| /.test(line) ? line : undefined);
    if (row === undefined) continue;
    for (const cell of row.split(/ \| |; /))
      out.push(
        cell
          .replace(/^[^=|]*=/, "")
          .replace(/ {2}\{node [^}]*\}$/, "")
          .replace(/ \{\d+\}$/, "")
          .replace(/^\s*(?:\[[+-]\] )?|\s+$/g, ""),
      );
  }
  return out;
}

/** A date as SAP writes it, in each of the user formats; the separator and the place of the year tell them apart. */
const DATE_FORMATS: [RegExp, string][] = [
  [/^\d{2}\.\d{2}\.\d{4}$/, "DD.MM.YYYY"],
  [/^\d{2}\/\d{2}\/\d{4}$/, "MM/DD/YYYY"],
  [/^\d{2}-\d{2}-\d{4}$/, "MM-DD-YYYY"],
  [/^\d{4}\.\d{2}\.\d{2}$/, "YYYY.MM.DD"],
  [/^\d{4}\/\d{2}\/\d{2}$/, "YYYY/MM/DD"],
  [/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"],
];

const isDate = (v: string) => DATE_FORMATS.some(([re]) => re.test(v)) || /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(v);

/** The date format the dates of a text show; undefined when it shows none, or several. */
export function dateFormatOf(text: string): string | undefined {
  const seen = new Set<string>();
  for (const v of valuesIn(text)) for (const [re, name] of DATE_FORMATS) if (re.test(v)) seen.add(name);
  return seen.size === 1 ? [...seen][0] : undefined;
}

/** A number with a point or a comma in it ("1.000", "312,000", "87.75", "1.234,56-"); not a date. */
export function hasPointOrComma(text: string): boolean {
  return valuesIn(text).some((v) => /^-?\d[\d., ]*\d-?$/.test(v) && /[.,]/.test(v) && !isDate(v) && !/^\d+(?:\.\d+){3}$/.test(v));
}

/** The notation a text's own NUMBERS line says ("NUMBERS 1.234,56 ..."), or what its amounts show; undefined when neither tells. */
export function notationIn(text: string): Notation | undefined {
  const line = /^(?:[~+=] )?NUMBERS 1([., ])234([.,])56\b/m.exec(text);
  if (line) return { sign: line[2] as "," | ".", spaced: line[1] === " ", from: "screen" };
  const shown = decimalOf(text);
  return shown ? { sign: shown.sign, spaced: /\d \d{3}/.test(shown.example), from: "screen" } : undefined;
}

/** The text has a NUMBERS line of its own (a view's, or a diff's line of it). */
const hasNumbersLine = (text: string) => /^(?:[~+=] )?NUMBERS /m.test(text);

/** The NUMBERS line for a notation the session knows; the line that says it is unknown, and where to find it, when it does not. */
export function notationLine(n: Notation | undefined): string {
  const dates = n?.date ? `; dates ${n.date}` : "";
  if (n?.sign) {
    const line = numbersLine(n.sign, n.spaced ? "1 234,56" : undefined);
    return `${line.replace(/\)$/, "")}${n.from === "settings" ? "; the user's setting" : "; as seen on an earlier screen"}${dates})`;
  }
  return `NUMBERS unknown  (no screen so far showed a decimal comma or point: "1.000" is 1000 with a comma, 1 with a point; "312,000" is 312 or 312000. Find out first: an amount with decimals on any screen, or okcode /nSU3, tab Defaults${dates})`;
}

/**
 * The answer with a NUMBERS line when it shows a number with a point or a
 * comma and says no notation of its own: under the header (TRANSACTION,
 * FIORI, or the CHANGED line of a diff), else first. `n` is what the session
 * knows; without it the line says the notation is unknown.
 */
export function withNumbers(answer: string, n: Notation | undefined): string {
  if (hasNumbersLine(answer) || !hasPointOrComma(answer)) return answer;
  const lines = answer.split("\n");
  const at = lines.findIndex((l) => /^(TRANSACTION |FIORI\b|CHANGED )/.test(l));
  lines.splice(at + 1, 0, notationLine(n));
  return lines.join("\n");
}

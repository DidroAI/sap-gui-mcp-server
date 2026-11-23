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

/** "1.250,00", "0,00", "1 250,5-": groups of three with a point or a space, a comma, one or two decimals. */
const DECIMAL_COMMA = /^-?\d{1,3}(?:[. ]?\d{3})*,\d{1,2}-?$/;
/** "1,250.00", "0.00". */
const DECIMAL_POINT = /^-?\d{1,3}(?:[, ]?\d{3})*\.\d{1,2}-?$/;

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
  for (const v of valuesOf(view)) {
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

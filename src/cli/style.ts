/**
 * Terminal colour for setup's output and its picker: green ✓, yellow !, red ✗ and dim secondary
 * text, only on a terminal and without NO_COLOR (https://no-color.org). Off, every function
 * returns its text as it is, so the output reads the same in CI or a pipe.
 */
export interface Style {
  green: (s: string) => string;
  yellow: (s: string) => string;
  red: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
}

const wrap = (on: boolean, open: number, close: number) => (s: string) => (on && s ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export function style(on: boolean): Style {
  return { green: wrap(on, 32, 39), yellow: wrap(on, 33, 39), red: wrap(on, 31, 39), dim: wrap(on, 2, 22), bold: wrap(on, 1, 22) };
}

/** Whether to colour what goes to this stream. */
export function useColor(stream: { isTTY?: boolean | undefined }, env: Record<string, string | undefined> = process.env): boolean {
  return !!stream.isTTY && !env.NO_COLOR && env.TERM !== "dumb";
}

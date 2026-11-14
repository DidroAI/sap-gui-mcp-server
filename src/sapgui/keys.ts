/**
 * SAP GUI takes function keys as virtual key numbers (SendVKey): 0 Enter,
 * 1 to 12 F1 to F12, 13 to 24 Shift+F1 to Shift+F12, 25 to 36 Ctrl+F1 to
 * Ctrl+F12, 37 to 48 Ctrl+Shift+F1 to Ctrl+Shift+F12, and a few more.
 * An agent may name the key instead ("Enter", "Shift+F3", "Control+s"):
 * this gives the number, the same one for the guard and for the action.
 */
const NAMED: Record<string, number> = {
  enter: 0,
  escape: 12,
  back: 3,
  "control+s": 11,
  "control+e": 70,
  "control+f": 71,
  "control+g": 84,
  "control+p": 86,
  "control+pageup": 80,
  pageup: 81,
  pagedown: 82,
  "control+pagedown": 83,
};

/** The virtual key number of a key given as a number or a name; undefined when SAP GUI has no such key. */
export function vkeyNumber(key: unknown): number | undefined {
  if (typeof key === "number") return Number.isInteger(key) && key >= 0 && key <= 99 ? key : undefined;
  if (typeof key !== "string") return undefined;
  const s = key.replace(/\s+/g, "").toLowerCase().replace(/^ctrl\+/, "control+");
  if (/^\d{1,2}$/.test(s)) return Number(s);
  const named = NAMED[s];
  if (named !== undefined) return named;
  const f = /^(control\+)?(shift\+)?f(\d{1,2})$/.exec(s);
  if (!f) return undefined;
  const n = Number(f[3]);
  if (n < 1 || n > 12) return undefined;
  return n + (f[1] ? 24 : 0) + (f[2] ? 12 : 0);
}

/** Small helpers for the texts of the stream. */

/** Bytes as text in the session's code page (UTF-8 on a Unicode system, else Latin-1). */
export function decode(b: Uint8Array, utf8 = true): string {
  return Buffer.from(b.buffer, b.byteOffset, b.length).toString(utf8 ? "utf8" : "latin1");
}

/** Text of a fixed-width field: without the padding at its end. */
export function clean(s: string): string {
  return s.replace(/[\u0000 ]+$/, "");
}

/** The strings of a buffer that holds NUL-terminated strings. */
export function cstrings(b: Uint8Array, utf8 = true): string[] {
  const s = decode(b, utf8).split("\0");
  if (s.length && s[s.length - 1] === "") s.pop();
  return s;
}

/** The NUL-terminated string at `at`. */
export function cstringAt(b: Buffer, at: number, utf8 = true, limit = b.length): string {
  if (at < 0 || at >= limit) return "";
  let end = b.indexOf(0, at);
  if (end < 0 || end > limit) end = limit;
  return decode(b.subarray(at, end), utf8);
}

export interface IconText {
  text: string;
  icon?: string;
  tooltip?: string;
}

/**
 * SAP writes an icon and a quick info into a text as `@<icon>\Q<quick info>@<text>`
 * ("@3Q@ Sales", "@0Y\QCreate@", "@\QSales Unit@Un"). The parts, the text trimmed.
 */
export function iconText(raw: string): IconText {
  const m = /^@([^@\\]{0,3})(?:\\Q([^@]*))?@([\s\S]*)$/.exec(raw);
  if (!m) return { text: raw.trim() };
  const out: IconText = { text: (m[3] ?? "").trim() };
  if (m[1]) out.icon = m[1];
  if (m[2]?.trim()) out.tooltip = m[2].trim();
  return out;
}

/** The tooltip of a property bag (`<Propertybag><DefaultTooltip>…</DefaultTooltip></Propertybag>`), if it has one. */
export function bagTooltip(xml: string): string | undefined {
  const m = /<(?:TooltipText|DefaultTooltip)>([^<]*)<\//.exec(xml);
  const t = m?.[1]?.trim();
  return t ? unescapeXml(t) : undefined;
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** Name of an SAP virtual key. */
export function keyName(vkey: number): string {
  if (vkey === 0) return "Enter";
  if (vkey >= 1 && vkey <= 48) {
    const prefix = ["", "Shift+", "Ctrl+", "Ctrl+Shift+"][Math.floor((vkey - 1) / 12)] ?? "";
    return `${prefix}F${((vkey - 1) % 12) + 1}`;
  }
  const named: Record<number, string> = { 70: "Ctrl+E", 71: "Ctrl+F", 72: "Ctrl+/", 73: "Ctrl+\\", 74: "Ctrl+N", 75: "Ctrl+O", 76: "Ctrl+X", 77: "Ctrl+C", 78: "Ctrl+V", 79: "Ctrl+Z", 80: "Ctrl+PageUp", 81: "PageUp", 82: "PageDown", 83: "Ctrl+PageDown", 84: "Ctrl+G", 85: "Ctrl+R", 86: "Ctrl+P" };
  return named[vkey] ?? `VKey ${vkey}`;
}

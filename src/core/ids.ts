/**
 * Short handles for SAP scripting ids, and which control a handle means.
 *
 * A scripting id is a path: `wnd[0]/usr/tabsTAB/tabpT\01/ssubBODY:PROG:4400/cntlTREE/shellcont/shell`.
 * The compact view shows a handle instead: the last segment when it is
 * unique on the screen, else the last segment with as few of the earlier
 * segments as make it unique (`cntlTREE/shell`, `shellcont[1]/shell`,
 * `wnd[1]/ctxtX`). A handle names an id when its last segment is the id's
 * last segment and its other segments appear in the id in that order.
 *
 * Every action resolves ids through `resolveId`: a handle that names several
 * controls is an error that lists them, never a guess.
 */

const split = (id: string): string[] => id.split("/");

/** Does `handle` name the control `full`? */
export function names(full: string, handle: string): boolean {
  if (full === handle) return true;
  const f = split(full);
  const h = split(handle);
  if (h.length > f.length || f[f.length - 1] !== h[h.length - 1]) return false;
  let i = f.length - 2;
  for (let j = h.length - 2; j >= 0; j--) {
    while (i >= 0 && f[i] !== h[j]) i--;
    if (i < 0) return false;
    i--;
  }
  return true;
}

const windowOf = (id: string): number => Number(/^wnd\[(\d+)\]/.exec(id)?.[1] ?? -1);

export type Resolved = { id: string } | { none: true } | { several: string[] };

/**
 * The one control of `ids` that `ident` means.
 * 1. the id itself;
 * 2. the controls the handle names; of several, those of the topmost window
 *    (a popup is in front of what it covers), then the one whose id ends
 *    with the handle;
 * 3. for a full id that is not on the screen: its last segment, by the same
 *    rule (models rebuild ids and get the path wrong), among the controls of
 *    the window the id names: `wnd[1]/tbar[0]/btn[12]` never means a button
 *    of the main window.
 */
export function resolveId(ids: Iterable<string>, ident: string): Resolved {
  const all = [...new Set(ids)];
  const want = ident.trim();
  if (!want) return { none: true };
  if (all.includes(want)) return { id: want };
  const pick = (handle: string, among: string[] = all): Resolved => {
    let hits = among.filter((id) => names(id, handle));
    if (!hits.length) return { none: true };
    if (hits.length > 1) {
      const top = Math.max(...hits.map(windowOf));
      hits = hits.filter((id) => windowOf(id) === top);
    }
    if (hits.length > 1) {
      const tail = hits.filter((id) => id.endsWith(`/${handle}`));
      if (tail.length === 1) hits = tail;
    }
    return hits.length === 1 ? { id: hits[0] as string } : { several: hits };
  };
  const found = pick(want);
  if (!("none" in found) || !want.startsWith("wnd[")) return found;
  const wnd = windowOf(want);
  return pick(
    want.slice(want.lastIndexOf("/") + 1),
    all.filter((id) => windowOf(id) === wnd),
  );
}

/** The text of the error for a handle that names several controls. */
export function severalText(ident: string, several: string[], shown: Map<string, string> = shortIds(several)): string {
  const list = several.slice(0, 8).map((id) => shown.get(id) ?? id);
  return `"${ident}" names ${several.length} controls on this screen: ${list.join(", ")}${several.length > 8 ? ", ..." : ""}. Use one of these ids.`;
}

/**
 * The handle the compact view shows for each id. Segments that only say
 * where a control sits (`usr`, a `shellcont` without a number) are never
 * added; a `shell` always keeps the container that names it (`cntlGRID/shell`),
 * because "shell" alone means another control on the next screen.
 */
export function shortIds(ids: Iterable<string>): Map<string, string> {
  const all = [...new Set(ids)];
  const lastCount = new Map<string, number>();
  for (const id of all) {
    const last = id.slice(id.lastIndexOf("/") + 1);
    lastCount.set(last, (lastCount.get(last) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const id of all) {
    const segs = split(id);
    const n = segs.length;
    const last = segs[n - 1] ?? "";
    if (n < 2 || !last) {
      out.set(id, id);
      continue;
    }
    // A menu entry is named by its whole path below the menu bar (menu[3]/menu[5]): "menu[5]" alone reads as a top menu.
    const menu = id.indexOf("/mbar/menu[");
    if (menu >= 0) {
      out.set(id, id.slice(menu + 6));
      continue;
    }
    const isShell = last === "shell";
    if (!isShell && lastCount.get(last) === 1) {
      out.set(id, last);
      continue;
    }
    const chosen = new Set<number>([n - 1]);
    if (isShell) {
      for (let j = n - 2; j >= 0; j--)
        if (/^cntl/.test(segs[j] ?? "")) {
          chosen.add(j);
          break;
        }
    }
    const handle = () => [...chosen].sort((a, b) => a - b).map((j) => segs[j]).join("/");
    const count = (h: string) => all.reduce((c, other) => c + (names(other, h) ? 1 : 0), 0);
    let c = count(handle());
    for (let j = n - 2; j >= 0 && c > 1; j--) {
      const seg = segs[j] ?? "";
      if (chosen.has(j) || seg === "usr" || seg === "shellcont" || seg === "shell") continue;
      chosen.add(j);
      const c2 = count(handle());
      if (c2 < c) c = c2;
      else chosen.delete(j);
    }
    // Still not unique (two controls with one id): the path below the user area, as before.
    out.set(id, c === 1 ? handle() : id.includes("/usr/") ? id.slice(id.indexOf("/usr/") + 5) : id);
  }
  return out;
}

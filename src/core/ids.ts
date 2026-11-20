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
 *    of the main window;
 * 4. an id written nearly right (`nearly`), when it then names one control.
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
  if (!("none" in found)) return found;
  if (want.startsWith("wnd[")) {
    const wnd = windowOf(want);
    const inWindow = pick(
      want.slice(want.lastIndexOf("/") + 1),
      all.filter((id) => windowOf(id) === wnd),
    );
    if (!("none" in inWindow)) return inWindow;
  }
  return nearly(all, want);
}

/** The last segment of an id without its type prefix (ctxtVBAK-VBELN -> VBAK-VBELN), in lower case. */
const bareName = (segment: string): string => segment.replace(/^[a-z]+/, "").toLowerCase();

/**
 * 4. An id that names nothing as written, and one control only when read
 *    the way models miswrite ids (measured on agent runs):
 *    - in another case (`likp-vbeln` for `ctxtLIKP-VBELN`): SAP names are upper case;
 *    - a table cell with the column counted wrong (`ctxtRV45A-MABNR[3,0]`
 *      where the screen has `ctxtRV45A-MABNR[1,0]`): the field's name and
 *      the row say which cell it is, the column index only where it stands
 *      in this layout of the table;
 *    - a table's own id with a cell's place (`tblX[1,0]`): the cell of that
 *      table at that column and row.
 *    Several candidates are never guessed among: the id then names nothing.
 */
function nearly(all: string[], want: string): Resolved {
  const wnd = want.startsWith("wnd[") ? windowOf(want) : -1;
  const pool = wnd < 0 ? all : all.filter((id) => windowOf(id) === wnd);
  const last = (id: string) => id.slice(id.lastIndexOf("/") + 1);
  const tail = last(want);
  const one = (hits: string[]): Resolved | undefined => {
    let h = [...new Set(hits)];
    if (h.length > 1) {
      const top = Math.max(...h.map(windowOf));
      h = h.filter((id) => windowOf(id) === top);
    }
    return h.length === 1 ? { id: h[0] as string } : undefined;
  };
  // Labels share their field's name (lblVBAK-VBELN): the field is meant.
  const fields = pool.filter((id) => !/^lbl/.test(last(id)));
  const low = tail.toLowerCase();
  const sameName = one(fields.filter((id) => last(id).toLowerCase() === low || bareName(last(id)) === low));
  if (sameName) return sameName;
  const cell = /^(.*)\[(\d+),(\d+)\]$/.exec(tail);
  if (cell) {
    const [, name = "", col = "", row = ""] = cell;
    if (/^tbl/.test(name)) {
      const inTable = one(fields.filter((id) => id.includes(`/${name}/`) && last(id).endsWith(`[${col},${row}]`)));
      if (inTable) return inTable;
    }
    const n = name.toLowerCase();
    const sameRow = one(
      fields.filter((id) => {
        const m = /^(.*)\[\d+,(\d+)\]$/.exec(last(id));
        return !!m && m[2] === row && ((m[1] ?? "").toLowerCase() === n || bareName(m[1] ?? "") === n || bareName(m[1] ?? "") === bareName(name));
      }),
    );
    if (sameRow) return sameRow;
  }
  return { none: true };
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

/**
 * The scripting id of a menu bar entry named the way an agent writes it:
 * "menu[2]/menu[1]" (the view's handle), "mbar/menu[2]/menu[1]" or the whole
 * "wnd[0]/mbar/menu[2]/menu[1]". undefined when the id names no menu entry.
 */
export function menuSid(id: string): string | undefined {
  const m = /^(?:(wnd\[\d+\])\/)?(?:mbar\/)?(menu\[\d+\](?:\/menu\[\d+\])*)$/.exec(id.trim());
  if (!m || (m[1] && !id.includes("/mbar/"))) return undefined;
  return `${m[1] ?? "wnd[0]"}/mbar/${m[2]}`;
}

/** A segment that is only a number in its container (btn[0], tbar[1], menu[3], lbl[1,13]): it names no field. */
export const numberedSegment = (segment: string): boolean => /^[a-z]*\[[\d,]+\]$/.test(segment);

/**
 * The handle code may name `full` by, among the controls `ids` of one
 * screen: its `shortIds` handle, when that is a tail of the id (so every
 * lookup, the replay's `locate` too, finds it the same way). Undefined for a
 * numbered control: `btn[0]` alone also names a popup's Continue, and the
 * next screen's toolbar numbers its buttons anew. Such controls are pressed
 * by their label in code instead.
 */
export function tailHandle(ids: Iterable<string>, full: string): string | undefined {
  const last = full.slice(full.lastIndexOf("/") + 1);
  if (!full.includes("/") || numberedSegment(last) || last === "shell") return undefined;
  const h = shortIds(ids).get(full);
  if (!h || h === full || !full.endsWith(`/${h}`)) return undefined;
  if (h.split("/").some(numberedSegment)) return undefined;
  return h;
}

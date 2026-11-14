/**
 * Which control an id from the agent means. In this order:
 * 1. a full scripting id ("wnd[0]/usr/ctxtVBAK-AUART");
 * 2. a full id that does not exist: its last segment (models rebuild ids and get the path wrong);
 * 3. the SAP field name ("VBAK-AUART") on the active window;
 * 4. a short id from the compact view: the end of a full id ("ctxtVBAK-AUART", "tblX/ctxtY[1,0]").
 * When several controls match, one the user can change wins, and a field wins over its label.
 */
import type { Control, Screen } from "./facts.js";

/** Controls of all windows; the content of a GuiShell (its inner containers) is left out of name matching. */
function candidates(screen: Screen, windowId?: string): Control[] {
  const out: Control[] = [];
  for (const w of screen.windows) {
    if (windowId !== undefined && w.id !== windowId) continue;
    const shells: string[] = [];
    for (const c of w.controls) {
      if (shells.some((s) => c.id.startsWith(s))) continue;
      out.push(c);
      if (c.type === "GuiShell") shells.push(`${c.id}/`);
    }
  }
  return out;
}

export function allControls(screen: Screen): Control[] {
  return screen.windows.flatMap((w) => w.controls);
}

/** The id without a session prefix ("/app/con[0]/ses[0]/wnd[0]/..." -> "wnd[0]/..."). */
export function relativeId(ident: string): string {
  return ident.trim().replace(/^\/?app\/con\[\d+\]\/ses\[\d+\]\//, "");
}

export function resolve(screen: Screen, ident: string): Control | undefined {
  let id = relativeId(ident);
  if (id.startsWith("wnd[")) {
    const exact = allControls(screen).find((c) => c.id === id);
    if (exact) return exact;
    id = id.slice(id.lastIndexOf("/") + 1);
  }
  let found = candidates(screen, screen.activeWindow ?? "wnd[0]").filter((c) => c.name === id);
  if (!found.length) found = candidates(screen).filter((c) => c.id.endsWith(`/${id}`));
  if (!found.length) return undefined;
  const rank = (c: Control) => (c.changeable ? 0 : 2) + (c.type === "GuiLabel" ? 1 : 0);
  return [...found].sort((a, b) => rank(a) - rank(b))[0];
}

/** A recorded step in a tester's words, shared by the exports people read (Cloud ALM, Gherkin) and the comments of the others. */
import type { Check, SapTest, Step } from "../format.js";

/** SAP's virtual keys as a tester knows them. */
export function keyName(k: unknown): string {
  if (typeof k !== "number") return String(k);
  const named: Record<number, string> = { 0: "Enter", 2: "F2 (Choose)", 3: "F3 (Back)", 4: "F4 (value help)", 8: "F8 (Execute)", 11: "Ctrl+S (Save)", 12: "F12 (Cancel)", 15: "Shift+F3 (Exit)" };
  if (named[k]) return named[k];
  if (k >= 1 && k <= 12) return `F${k}`;
  if (k >= 13 && k <= 24) return `Shift+F${k - 12}`;
  if (k >= 25 && k <= 36) return `Ctrl+F${k - 24}`;
  if (k >= 37 && k <= 48) return `Ctrl+Shift+F${k - 36}`;
  return `key ${k}`;
}

const lastSegment = (id: string) => id.slice(id.lastIndexOf("/") + 1);

/** `"Standard Order" (VBAK-VBELN)`: the label a tester sees, and the field name a consultant looks for. */
export function controlName(s: Step): string {
  const id = String(s.target?.id ?? s.action?.id ?? "");
  const tech = lastSegment(id).replace(/^[a-z]+(?=[A-Z])/, "");
  const label = s.target?.label;
  // The field name helps a consultant find a field; a tab or a button has none worth showing.
  const named = ["field", "checkbox", "radio", "dropdown"].includes(s.target?.type ?? "") && /[A-Z]/.test(tech);
  return label ? `"${label}"${named ? ` (${tech})` : ""}` : tech || id;
}

/** What the tester does at this step, as one sentence without a full stop. */
export function doing(s: Step): string {
  const a = s.action;
  if (!a) return "Check the screen";
  const v = String(a.value ?? "");
  const what = controlName(s);
  switch (a.do) {
    case "okcode": {
      const t = /^\/[nN](\S+)$/.exec(v)?.[1];
      return t ? `Start transaction ${t.toUpperCase()} (enter ${v} in the command field)` : `Enter ${v} in the command field`;
    }
    case "set":
      return `Enter "${v}" in the field ${what}`;
    case "key":
      return `Press ${keyName(a.key)}`;
    case "press":
    case "click":
      return `Press the button ${what}`;
    case "select":
      return s.target?.type === "tab" ? `Open the tab ${what}` : `Select ${what}`;
    case "check":
      return `${a.value === false || a.value === "false" ? "Clear" : "Tick"} the checkbox ${what}`;
    case "combo":
      return `Choose "${String(a.key ?? a.value ?? "")}" in the dropdown ${what}`;
    case "f4":
      return `Open the value help of the field ${what}`;
    case "dblclick":
      return `Double-click ${what}`;
    case "focus":
      return `Put the cursor in ${what}`;
    case "tree":
      return `${a.how === "expand" ? "Expand" : a.how === "select" ? "Select" : "Double-click"} the tree node ${String(a.node ?? "")} in ${what}`;
    case "grid":
      return `${a.how === "select" ? "Select" : "Double-click"} row ${Number(a.row ?? 0) + 1}${a.col ? `, column ${a.col}` : ""} of the list ${what}`;
    case "toolbar":
      return `Press the toolbar button ${String(a.button ?? "")} of ${what}`;
    case "scroll":
      return `Scroll ${String(a.how ?? "down")}`;
    default:
      return `${a.do} ${what}`;
  }
}

export function checkText(c: Check): string {
  const verb = c.op === "equals" ? "is" : c.op === "contains" ? "contains" : "matches";
  if (c.check === "status") return `The status bar ${c.op === "equals" ? "says" : verb} "${c.value}"`;
  if (c.check === "title") return `The window title ${verb} "${c.value}"`;
  if (c.check === "transaction") return `The transaction ${verb} ${c.value}`;
  if (c.check === "text") return `The screen ${c.op === "matches" ? "matches" : "shows"} "${c.value}"`;
  const tech = lastSegment(c.id ?? "").replace(/^[a-z]+(?=[A-Z])/, "");
  return `The ${c.type === "checkbox" ? "checkbox" : "field"} ${c.label ? `"${c.label}"${tech ? ` (${tech})` : ""}` : tech || (c.id ?? "")} ${c.type === "checkbox" && c.op === "equals" ? (c.value === "true" ? "is ticked" : "is not ticked") : `${verb} "${c.value}"`}`;
}

/** What the tester should see after the step: a new screen, the status bar, then the marked checks. */
export function expected(s: Step): string[] {
  const out: string[] = [];
  const a = s.after;
  if (a?.title && (a.title !== s.on?.title || a.program !== s.on?.program || a.screen !== s.on?.screen)) out.push(`The screen "${a.title}" appears`);
  if (a?.status?.text && !(s.expect ?? []).some((c) => c.check === "status")) out.push(`The status bar says "${a.status.text}"`);
  for (const c of s.expect ?? []) out.push(checkText(c));
  for (const c of s.capture ?? []) out.push(`Note the value of ${c.from === "field" ? `the field "${c.label ?? c.id}"` : c.from === "status" ? "the status bar" : "the window title"} as \${${c.var}}`);
  return out;
}

/** `${order}` as people write a placeholder: `<order>`. */
export const human = (text: string) => text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "<$1>");

export const systemOf = (t: SapTest) => `${t.recorded.system ?? "the SAP system"}${t.recorded.client ? `, client ${t.recorded.client}` : ""}`;
export const surfaceName = (t: SapTest) => (t.recorded.surface === "sapgui" ? "SAP GUI for Windows" : t.recorded.surface === "webgui" ? "SAP GUI for HTML (Web GUI)" : "SAP Fiori");

/**
 * What a Fiori action may do to the system: read, navigate or commit.
 *
 * The rule is a table (RULES): the first row that matches the control decides.
 * It reads four things of the control, all found by the in-page reader
 * (ControlFacts in ui5.ts): its id (Fiori elements gives its standard actions
 * stable ids), its press handler names, its text, and its button type with
 * where it sits (page footer, dialog, filter bar, value help).
 *
 * The table fails closed: a button, a menu entry or anything else with a
 * press handler is a commit unless a row says it is safe. Safe by id are the
 * standard actions that do not write (Edit, Cancel, Go, value help, sort,
 * filter...). Safe by text are the words of core/words.ts (Back, Cancel,
 * Display, Find, Refresh, Next, Sort, Filter, Go...), and only when the
 * page's language is one that table covers; in any other language a button
 * is safe by its id alone.
 *
 * Draft apps: typing into a field of a draft-enabled app saves the draft on
 * the server at once. That is not counted as a commit; activating the draft
 * (Save, Create) is.
 */
import type { Action, Assessment, Risk } from "../core/types.js";
import { commitWord, endsLogon, safeWord } from "../core/words.js";
import type { ControlFacts } from "./ui5.js";

/** What the rules know beyond the control: the page's language ("en-US"), for the safe words. */
export interface RuleContext {
  language?: string | undefined;
}

/** "Yes" to a dialog: the dialog's own text says what that does. */
const YES_TEXT = /^(yes|ja|oui|sí|si|sim|ja)$/i;

/** Icons of buttons that have no text, where the icon alone says the button only moves or shows. */
const ICON_SAFE = /^(search|filter|sort|sort-ascending|sort-descending|refresh|nav-back|navigation-(left|right|up|down)-arrow|slim-arrow-(left|right|up|down)|expand|collapse|expand-all|collapse-all|expand-group|collapse-group|full-screen|exit-full-screen|sys-help|sys-help-2|value-help|overflow|menu2|drop-down-list|action-settings)$/i;

/** Standard actions of SAP Fiori elements by id: OData V4 (`fe::…StandardAction::Save`) and V2 (`--save`, `--activate`). */
const ID_COMMIT = /::StandardAction::(Save|Create|Delete|CreateDocument|MassEdit|Paste|Insert)\b|(?:--|::)(save|activate|delete|deleteEntry|addEntry|copy|copyButton|saveAsDraft|saveAndNew|saveAndNext|activateAndNew)$/i;
const ID_SAFE = /::StandardAction::(Edit|Cancel|Discard|SwitchToActiveObject|SwitchToDraftObject|SwitchDraftAndActiveObject|FullScreen|EnterFullScreen|ExitFullScreen|Close|Share)\b|(?:--|::)(edit|discard|cancel|close|back|fullScreen|closeColumn|exitFullScreen|share)$/i;
/** A back-end action behind a button: an OData action or function import (`DataFieldForAction`, `--action::…`). */
const ID_ACTION = /DataFieldForAction::|(?:--|::)action::/i;
const ID_READ = /-btnGo$|-btnSearch$|::FilterBar-btnSearch$|-btn(Filters|Clear|Restore|ShowHide|AdaptFilters)$|::AdaptFilters$|-vhi$|-valueHelp|::StandardAction::(Sort|Filter|Group|Personalization|Export|ExportToExcel|ShowDetails|HideDetails)\b|-(btnPersonalisation|btnExcelExport|btnFullScreen|header-expandBtn|expandBtn|collapseBtn|pinBtn|overflowButton)$|-searchField/i;
const HANDLER_COMMIT = /save|create|post|delet|submit|approv|reject|release|activat|commit|send/i;

const BUTTON_LIKE = /Button$|MenuItem$|ActionListItem$|ActionSelect$|sap\.m\.Link$/;
const ROW_LIKE = /ColumnListItem$|sap\.ui\.table\.Row$|ListItem$|Tile$|TileContent$|IconTabFilter$|SegmentedButtonItem$|ObjectPageSection$|ObjectPageSubSection$|VizInstance/;
const FIELD_LIKE = /Input$|Field$|TextArea$|Picker$|ComboBox$|Select$|CheckBox$|Switch$|RadioButton$|DynamicDateRange$|Token$|Tokenizer$|Slider$/;
const STRONG_TYPE = /^(Emphasized|Accept|Reject)$/;

const isButton = (f: ControlFacts) => BUTTON_LIKE.test(f.type) || (/ListItem$/.test(f.type) && /Popover$|ActionSheet$|Menu$/.test(f.dialog?.type ?? ""));
/** Not a button, a row or a field, yet it reacts to a press: an icon, an image, an avatar, a custom control. */
const isPressable = (f: ControlFacts) => (f.handlers ?? []).length > 0;
const commitText = (s: string | undefined) => commitWord(s);
const safeText = (f: ControlFacts, ctx: RuleContext) => !!safeWord(ctx.language, f.text);
/** "OK" (the same in every language) or "Continue": the button only agrees with what the dialog says. */
const agrees = (f: ControlFacts, ctx: RuleContext) => /^ok$/i.test(f.text.trim()) || safeWord(ctx.language, f.text) === "enter";
const isLink = (f: ControlFacts) => /Link$|ObjectIdentifier$/.test(f.type);

export interface Rule {
  /** Short name, shown in tests and used in the reason. */
  name: string;
  risk: Risk;
  when: (f: ControlFacts, ctx: RuleContext) => boolean;
}

/**
 * The table. Order matters: ids first (the most certain), then links and
 * rows, then the text, then the button type with its place.
 */
export const RULES: Rule[] = [
  { name: "standard action that writes (id)", risk: "commit", when: (f) => ID_COMMIT.test(f.id) },
  { name: "back-end action (id)", risk: "commit", when: (f) => ID_ACTION.test(f.id) },
  { name: "value help, filter or search (id)", risk: "read", when: (f) => ID_READ.test(f.id) },
  { name: "standard action that does not write (id)", risk: "navigate", when: (f) => ID_SAFE.test(f.id) },
  { name: "link with an address", risk: "navigate", when: (f) => !!f.href },
  { name: "row, tile, tab or list entry", risk: "navigate", when: (f) => ROW_LIKE.test(f.type) && !isButton(f) },
  { name: "field", risk: "navigate", when: (f) => FIELD_LIKE.test(f.type) && !isButton(f) },
  { name: "press handler that writes", risk: "commit", when: (f) => (isButton(f) || isPressable(f)) && (f.handlers ?? []).some((h) => HANDLER_COMMIT.test(h)) },
  { name: "text says it writes", risk: "commit", when: (f) => (isButton(f) || isPressable(f)) && !!commitText(f.text) },
  {
    name: "agrees to a dialog that writes",
    risk: "commit",
    when: (f, ctx) => isButton(f) && (agrees(f, ctx) || YES_TEXT.test(f.text.trim())) && !!f.dialog && !f.inValueHelp && !!commitText(`${f.dialog.title} ${f.dialog.text}`),
  },
  { name: "agrees to a dialog", risk: "navigate", when: (f, ctx) => isButton(f) && agrees(f, ctx) && !!f.dialog },
  { name: "button of a filter bar or value help", risk: "read", when: (f) => isButton(f) && (!!f.inFilterBar || !!f.inValueHelp) },
  { name: "text says it does not write", risk: "navigate", when: (f, ctx) => (isButton(f) || isPressable(f)) && safeText(f, ctx) },
  { name: "emphasized button of a footer toolbar", risk: "commit", when: (f) => isButton(f) && !!f.inFooter && STRONG_TYPE.test(f.buttonType ?? "") },
  { name: "emphasized button of a dialog", risk: "commit", when: (f) => isButton(f) && !!f.dialog && /Dialog$|MessageBox$/.test(f.dialog.type) && STRONG_TYPE.test(f.buttonType ?? "") },
  { name: "link", risk: "navigate", when: (f) => isLink(f) },
  { name: "button that opens a menu", risk: "navigate", when: (f) => /MenuButton$/.test(f.type) },
  { name: "icon says it does not write", risk: "navigate", when: (f) => (isButton(f) || isPressable(f)) && !f.text && ICON_SAFE.test(f.icon ?? "") },
  { name: "button that is not known to be safe", risk: "commit", when: (f) => isButton(f) },
  { name: "control with a press handler that is not known to be safe", risk: "commit", when: (f) => isPressable(f) },
];

const label = (f: ControlFacts) => `${f.type.replace(/^.*\./, "").toLowerCase()} "${f.text || f.icon || f.id.split(/--|::/).pop()}"`;

/** Pressing, clicking or selecting one control. */
export function assessControl(f: ControlFacts, ctx: RuleContext = {}): Assessment & { rule: string } {
  for (const r of RULES) if (r.when(f, ctx)) return { risk: r.risk, reason: `${label(f)}: ${r.name}`, rule: r.name };
  // A text, a title, a layout: nothing to press.
  return { risk: "navigate", reason: label(f), rule: "default" };
}

/** Keys the Fiori driver knows, by the name Playwright presses. */
export const KEYS: Record<string, { press: string; risk: Risk }> = {
  enter: { press: "Enter", risk: "navigate" },
  space: { press: "Space", risk: "navigate" },
  escape: { press: "Escape", risk: "navigate" },
  esc: { press: "Escape", risk: "navigate" },
  tab: { press: "Tab", risk: "read" },
  "shift+tab": { press: "Shift+Tab", risk: "read" },
  f4: { press: "F4", risk: "read" },
  arrowdown: { press: "ArrowDown", risk: "read" },
  arrowup: { press: "ArrowUp", risk: "read" },
  arrowleft: { press: "ArrowLeft", risk: "read" },
  arrowright: { press: "ArrowRight", risk: "read" },
  pagedown: { press: "PageDown", risk: "read" },
  pageup: { press: "PageUp", risk: "read" },
  home: { press: "Home", risk: "read" },
  end: { press: "End", risk: "read" },
  back: { press: "Back", risk: "navigate" },
  "control+s": { press: "Control+s", risk: "commit" },
  "control+enter": { press: "Control+Enter", risk: "commit" },
};
/** SAP GUI virtual keys an agent may send out of habit: 0 Enter, 3 Back, 4 F4, 11 Save, 12 Cancel. */
const VKEYS: Record<number, string> = { 0: "enter", 3: "back", 4: "f4", 11: "control+s", 12: "escape" };

/** The key of a key action, normalised to an entry of KEYS (or undefined). */
export function keyOf(action: Action): { name: string; press: string; risk: Risk } | undefined {
  const k = action.key ?? action.value;
  const raw = typeof k === "number" || /^\d+$/.test(String(k ?? "")) ? VKEYS[Number(k)] : String(k ?? "");
  const name = (raw ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^ctrl\+/, "control+")
    .replace(/^return$/, "enter");
  const e = KEYS[name];
  return e ? { name, ...e } : undefined;
}

/** What the page says about the place a key would land: the focused control and the open dialog's default button. */
export interface KeyContext extends RuleContext {
  focused?: ControlFacts | undefined;
  dialogDefault?: ControlFacts | undefined;
}

/**
 * One action, from the facts of its control (undefined when the id is not on
 * the screen: the action will fail, nothing is written).
 */
export function assessAction(action: Action, facts: ControlFacts | undefined, ctx: KeyContext = {}): Assessment {
  const d = action.do === "fill" ? "set" : action.do === "double" ? "dblclick" : action.do;
  if (d === "scroll" || d === "f4") return { risk: "read", reason: d === "f4" ? "value help" : "scroll" };
  if (d === "key") {
    const k = keyOf(action);
    if (!k) return { risk: "commit", reason: `key ${JSON.stringify(action.key ?? action.value ?? "")} is not one the Fiori surface knows` };
    if (k.risk === "commit") return { risk: "commit", reason: `key ${k.press} saves in Fiori apps` };
    if (k.name === "enter" || k.name === "space") {
      // Enter and Space press the focused button; Enter also presses the default button of an open dialog.
      for (const f of k.name === "enter" ? [ctx.focused, ctx.dialogDefault] : [ctx.focused]) {
        if (!f || !(isButton(f) || isPressable(f))) continue;
        const a = assessControl(f, ctx);
        if (a.risk === "commit") return { risk: "commit", reason: `${k.press} would press ${a.reason}` };
      }
    }
    return { risk: k.risk, reason: `key ${k.press}` };
  }
  if (d === "okcode" || d === "tree" || d === "grid" || d === "toolbar") return { risk: "read", reason: `"${d}" needs a Web GUI screen` };
  // An id the screen does not have: the action fails in the page, where the control is looked up again.
  if (!facts) return d === "press" || d === "click" || d === "select" || d === "dblclick" ? { risk: "commit", reason: `no control "${action.id ?? ""}" on the screen the server read, so what it does is unknown` } : { risk: "read", reason: `no control "${action.id ?? ""}" on the screen` };
  if (d === "set" || d === "combo" || d === "check") {
    // A toggle button is a button; a field that is a button (an action select) too.
    if (d === "check" && isButton(facts)) return assessControl(facts, ctx);
    const where = facts.inValueHelp ? "value help" : facts.inFilterBar ? "filter" : "";
    return where ? { risk: "read", reason: `${where} field` } : { risk: "navigate", reason: `unsaved input in ${label(facts)}` };
  }
  if (d === "focus") return { risk: "read", reason: "focus" };
  if (d === "press" || d === "click" || d === "select" || d === "dblclick") {
    const a = assessControl(facts, ctx);
    // "Sign Out", "Log Off": ending the logon is refused on its own rule (core/guard.ts, SAP_ALLOW_LOGOFF).
    return (isButton(facts) || isPressable(facts)) && endsLogon(facts.text) ? { ...a, risk: "commit", closes: true } : a;
  }
  return { risk: "commit", reason: `action "${d}" is not one the Fiori surface knows` };
}

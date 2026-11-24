/**
 * SAP GUI scripting, as a VBScript file in the style of SAP GUI's own
 * recorder ("Script Recording and Playback"): `session.findById(...)` calls
 * on the same ids. Run it from SAP GUI's playback, or with
 * `cscript //nologo test.vbs /order:19097` (variables are named arguments).
 *
 * A Web GUI recording exports too: Web GUI carries the same scripting ids.
 * A Fiori recording does not (no scripting ids).
 *
 * Beyond the recorder's style, the script checks what the replay checks:
 * no error in the status bar, the recorded screen, and the marked checks.
 * It stops at the first failure with exit code 1.
 */
import type { Capture, Check, SapTest, Step } from "../format.js";
import { doing, human } from "./words.js";

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** A VBScript string expression: `"Order " & v_order & " saved"`. */
export function vbsString(text: string): string {
  const parts: string[] = [];
  let at = 0;
  for (const m of text.matchAll(VAR)) {
    if (m.index > at) parts.push(`"${text.slice(at, m.index).replace(/"/g, '""')}"`);
    parts.push(`v_${m[1]}`);
    at = m.index + m[0].length;
  }
  if (at < text.length || !parts.length) parts.push(`"${text.slice(at).replace(/"/g, '""')}"`);
  return parts.join(" & ");
}

const find = (id: string) => `session.findById(${vbsString(id)})`;

/** A named key ("Enter", "Shift+F3", "Control+s") as an SAP virtual key number. */
export function vkeyNumber(key: unknown): number | undefined {
  if (typeof key === "number") return key;
  const k = String(key);
  if (k === "Enter") return 0;
  if (k === "Escape") return 12;
  if (k === "Back") return 3;
  if (/^control\+s$/i.test(k)) return 11;
  const m = /^(Control\+)?(Shift\+)?F(\d{1,2})$/.exec(k);
  if (!m) return undefined;
  const n = Number(m[3]);
  if (n < 1 || n > 12) return undefined;
  return n + (m[1] ? 24 : 0) + (m[2] ? 12 : 0);
}

function fullId(s: Step): string | undefined {
  const id = s.target?.id ?? (typeof s.action?.id === "string" ? s.action.id : undefined);
  return id?.startsWith("wnd[") ? id : undefined;
}

function actionLines(s: Step): string[] {
  const a = s.action;
  if (!a) return [];
  if (a.do === "okcode") return [`${find("wnd[0]/tbar[0]/okcd")}.text = ${vbsString(String(a.value ?? ""))}`, `${find("wnd[0]")}.sendVKey 0`];
  if (a.do === "key") {
    const n = vkeyNumber(a.key);
    return n === undefined ? [`' TODO: the key ${String(a.key)} has no SAP virtual key number`] : [`session.ActiveWindow.sendVKey ${n}`];
  }
  const id = fullId(s);
  if (!id) return [`' TODO: step recorded with the short id "${String(a.id ?? "")}" and no full id: replace it with the control's full id (wnd[0]/usr/...)`];
  const o = find(id);
  switch (a.do) {
    case "set":
      return [`${o}.text = ${vbsString(String(a.value ?? ""))}`];
    case "press":
      return [`${o}.press`];
    case "focus":
      return [`${o}.setFocus`];
    case "select":
      return [`${o}.select`];
    case "check":
      return [`${o}.selected = ${a.value === false || /^(false|0|off|no)$/i.test(String(a.value)) ? "False" : "True"}`];
    case "combo":
      return [`${o}.key = ${vbsString(String(a.key ?? a.value ?? ""))}`];
    case "f4":
      return [`${o}.setFocus`, "session.ActiveWindow.sendVKey 4"];
    case "dblclick":
      return [`${o}.setFocus`, "session.ActiveWindow.sendVKey 2"];
    case "tree": {
      const node = vbsString(String(a.node ?? ""));
      const call = a.how === "expand" ? "expandNode" : a.how === "collapse" ? "collapseNode" : a.how === "select" ? "selectNode" : "doubleClickNode";
      return [`' Node keys are padded with spaces in some trees: NodeKey finds the real one.`, `${o}.${call} NodeKey(${o}, ${node})`];
    }
    case "grid":
      return [`${o}.setCurrentCell ${Number(a.row ?? 0)}, ${vbsString(String(a.col ?? ""))}`, a.how === "select" ? `${o}.selectedRows = "${Number(a.row ?? 0)}"` : `${o}.doubleClickCurrentCell`];
    case "toolbar":
      return [`${o}.pressToolbarButton ${vbsString(String(a.button ?? ""))}`];
    default:
      return [`' TODO: "${a.do}" has no SAP GUI scripting equivalent`];
  }
}

function actual(c: Check | Capture): string | undefined {
  const what = "check" in c ? c.check : c.from;
  if (what === "status") return `${find("wnd[0]/sbar")}.Text`;
  if (what === "title") return "session.ActiveWindow.Text";
  if (what === "transaction") return "session.Info.Transaction";
  if (what === "field" && c.id?.startsWith("wnd[")) return "type" in c && (c.type === "checkbox" || c.type === "radio") ? `LCase(CStr(${find(c.id)}.Selected))` : `${find(c.id)}.Text`;
  return undefined;
}

const HEADER = `If Not IsObject(application) Then
   Set SapGuiAuto  = GetObject("SAPGUI")
   Set application = SapGuiAuto.GetScriptingEngine
End If
If Not IsObject(connection) Then
   Set connection = application.Children(0)
End If
If Not IsObject(session) Then
   Set session    = connection.Children(0)
End If
If IsObject(WScript) Then
   WScript.ConnectObject session,     "on"
   WScript.ConnectObject application, "on"
End If
session.findById("wnd[0]").maximize

Function Var(name, default)
   Var = default
   If IsObject(WScript) Then
      If WScript.Arguments.Named.Exists(name) Then Var = WScript.Arguments.Named(name)
   End If
End Function

Sub Fail(n, why)
   message = "FAIL step " & n & ": " & why & " [" & session.Info.Transaction & " " & session.Info.Program & "/" & session.Info.ScreenNumber & "] status: " & session.findById("wnd[0]/sbar").Text
   If IsObject(WScript) Then
      WScript.Echo message
      WScript.Quit 1
   End If
   MsgBox message
   Err.Raise vbObjectError + 1, "sap test", message
End Sub

' After each step: no error in the status bar, and the recorded screen.
Sub Landed(n, program, screenNumber)
   t = session.findById("wnd[0]/sbar").MessageType
   If t = "E" Or t = "A" Then Fail n, "SAP reported an error"
   If program <> "" And (session.Info.Program <> program Or CStr(session.Info.ScreenNumber) <> screenNumber) Then Fail n, "landed on another screen, recorded " & program & "/" & screenNumber
End Sub

Sub Expect(n, what, actual, op, expected)
   ok = False
   If op = "equals" Then ok = (Trim(actual) = Trim(expected))
   If op = "contains" Then ok = (InStr(actual, expected) > 0)
   If op = "matches" Then
      Set re = New RegExp
      re.Pattern = expected
      ok = re.Test(actual)
   End If
   If Not ok Then Fail n, what & " is """ & actual & """, expected " & op & " """ & expected & """"
End Sub

Function Capture(n, actual, pattern)
   Capture = Trim(actual)
   If pattern <> "" Then
      Set re = New RegExp
      re.Pattern = pattern
      Set found = re.Execute(actual)
      If found.Count = 0 Then Fail n, "nothing to capture: """ & actual & """ does not match " & pattern
      If found(0).SubMatches.Count > 0 Then Capture = found(0).SubMatches(0) Else Capture = found(0).Value
   End If
   If Capture = "" Then Fail n, "nothing to capture"
End Function

Function NodeKey(tree, wanted)
   NodeKey = wanted
   For Each k In tree.GetAllNodeKeys
      If Trim(k) = Trim(wanted) Then NodeKey = k
   Next
End Function
`;

export function exportVbs(test: SapTest): string {
  if (test.recorded.surface === "fiori") throw new Error("a Fiori recording has no SAP GUI scripting ids: it cannot become a SAP GUI script");
  if (test.recorded.method === "diag") throw new Error("a recording made through the DIAG method names controls by SAP field name, not by SAP GUI scripting id: it cannot become a SAP GUI script");
  const out: string[] = [
    `' ${test.name}`,
    ...(test.description ? [`' ${test.description.replace(/\r?\n/g, " ")}`] : []),
    `' Generated by sap-ui-automation from a recording on ${test.recorded.surface}${test.recorded.system ? `, ${test.recorded.system}` : ""}${test.recorded.client ? `/${test.recorded.client}` : ""}, ${test.recorded.at}.`,
    `' Run in SAP GUI (Customize Local Layout > Script Recording and Playback), or:`,
    `'   cscript //nologo this.vbs${Object.keys(test.variables).map((k) => ` /${k}:<value>`).join("")}`,
    "",
    HEADER,
  ];
  const vars = Object.entries(test.variables);
  if (vars.length) out.push("' Test data: the defaults are the recorded values.", ...vars.map(([k, v]) => `v_${k} = Var("${k}", ${vbsString(v.value)})${v.description ? `  ' ${v.description}` : ""}`), "");
  const first = test.steps[0]?.action;
  const t = test.start.transaction;
  if (!(first?.do === "okcode" && /^\/n\S/i.test(String(first.value ?? ""))) && t && !["SESSION_MANAGER", "SMEN", "S000"].includes(t.toUpperCase()))
    out.push(`' A clean start: the recording began in ${t}.`, `${find("wnd[0]/tbar[0]/okcd")}.text = "/n${t}"`, `${find("wnd[0]")}.sendVKey 0`, "");
  test.steps.forEach((s, i) => {
    const n = i + 1;
    out.push(`' ${n}. ${human(doing(s))}${s.note ? ` (${s.note.replace(/\r?\n/g, " ")})` : ""}`);
    out.push(...actionLines(s));
    if (s.action) out.push(`Landed ${n}, "${s.after?.program ?? ""}", "${s.after?.screen ?? ""}"`);
    for (const c of s.capture ?? []) {
      const a = actual(c);
      out.push(a ? `v_${c.var} = Capture(${n}, ${a}, ${vbsString(c.pattern ?? "")})` : `' TODO: capture of \${${c.var}} needs the control's full id`);
    }
    for (const c of s.expect ?? []) {
      const a = actual(c);
      const name = c.check === "field" ? (c.label ?? c.id ?? "field") : c.check;
      out.push(a ? `Expect ${n}, ${vbsString(name)}, ${a}, "${c.op}", ${vbsString(c.value)}` : `' TODO: check not exported (${c.check} ${c.op} "${c.value}"): SAP GUI scripting has no equivalent, or the id is not a full id`);
    }
    out.push("");
  });
  out.push(`If IsObject(WScript) Then WScript.Echo "PASS ${test.name.replace(/"/g, "'")} (${test.steps.length} steps)"`);
  return `${out.join("\r\n").replace(/(?<!\r)\n/g, "\r\n")}\r\n`;
}

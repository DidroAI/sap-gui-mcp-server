// End-to-end check of the sapgui surface on Windows: the built server over
// stdio, its PowerShell host, and SAP GUI scripting through COM.
//
//   node test/sapgui/e2e.mjs            against the fake SAP GUI (fake-sapgui.wsc, no SAP GUI needed)
//   node test/sapgui/e2e.mjs --real     against the SAP GUI that is open (reads only: sessions, look, screenshot);
//                                       E2E_FULL_OUT=<file> also writes the full view there
//
// Run `bun run build` first. See test/sapgui/README.md.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const real = process.argv.includes("--real");
const env = { ...process.env, SAP_SURFACES: "sapgui" };
if (!real) {
  env.SAPGUI_MCP_FAKE = `script:${join(here, "fake-sapgui.wsc")}`;
  env.SAPGUI_MCP_FAKE_WORLD = join(here, "fixtures", "world.json");
}
const client = new Client({ name: "sapgui-e2e", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(here, "..", "..", "dist", "cli.js")], env }));

let failed = 0;
async function call(name, args = {}) {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => (c.type === "text" ? c.text : `<${c.type} ${c.mimeType} ${c.data.length} base64 chars>`)).join("\n");
  return { text, error: !!r.isError, ms: Date.now() - t };
}
function check(what, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `  ${detail}` : ""}`);
}
const act = (action, session) => call("sap_act", { action, ...(session ? { session } : {}) });

const sessions = await call("sap_sessions");
console.log(sessions.text);
check("sap_sessions lists sessions", !sessions.error && /sapgui/.test(sessions.text), `${sessions.ms} ms (host start included)`);

if (real) {
  const look = await call("sap_look");
  console.log(look.text);
  check("sap_look", !look.error && look.text.startsWith("TRANSACTION"), `${look.ms} ms`);
  const again = await call("sap_look", { full: true });
  check("sap_look full, host warm", !again.error, `${again.ms} ms, ${again.text.length} chars`);
  if (process.env.E2E_FULL_OUT) writeFileSync(process.env.E2E_FULL_OUT, `${again.text}\n`);
  const shot = await call("sap_screenshot");
  check("sap_screenshot", !shot.error && shot.text.includes("image/png"), `${shot.ms} ms ${shot.text}`);
} else {
  check("the user's session is first and active", /^1\. \* sapgui\s+DEM \(100\) TESTER\s+VA03/.test(sessions.text));
  check("where names the connection and session", sessions.text.includes("[SAP GUI DEM demo system, session 2]  id=sapgui:/app/con[0]/ses[1]"));

  let r = await call("sap_look");
  check("sap_look, compact", r.text.includes("row 1: Item=20; Material=M-02; Order Quantity=1; Rej [x]"), `${r.ms} ms`);
  r = await call("sap_look", { full: true });
  check("sap_look, full", r.text.includes("tblSAPMV45ATCTRL_U_ERF_AUFTRAG/txtVBAP-POSNR[0,0]  field   = \"10\"  (read-only)"), `${r.ms} ms`);
  const times = [];
  for (let i = 0; i < 5; i++) times.push((await call("sap_look", { session: "VA05" })).ms);
  check("sap_look, host warm (ALV list, 50 rows)", true, `${times.join(", ")} ms`);

  r = await act({ do: "set", id: "ctxtVBAK-AUART", value: "RE" }, "sapgui:/app/con[0]/ses[0]");
  check("set a field", r.text.includes('ctxtVBAK-AUART  field  Order Type = "RE"  (edit)'), `${r.ms} ms`);
  r = await act({ do: "press", id: "tbar[1]/btn[8]" }, "sapgui:/app/con[0]/ses[0]");
  check("press a button", r.text.includes("status  S: fake: Press wnd[0]/tbar[1]/btn[8]"));
  r = await act({ do: "select", id: "tabpT\\02" });
  check("select a tab", r.text.includes("fake: Select wnd[0]/usr/tabsTAXI_TABSTRIP_OVERVIEW/tabpT\\02"));
  r = await act({ do: "combo", id: "cmbVBAK-LIFSK", key: "Credit limit" });
  check("dropdown by its text", r.text.includes('dropdown  Delivery block = "01"'));
  r = await act({ do: "check", id: "chkVBAK-AUTLF", value: false });
  check("checkbox", r.text.includes("checkbox  [ ] Complete dlv."));
  const tree = "wnd[0]/usr/tabsTAXI_TABSTRIP_HEAD/tabpT\\08/cntlSPLITTER_CONTAINER/shellcont/shell/shellcont[0]/shell";
  r = await act({ do: "tree", id: tree, node: "3", how: "double" }, "sapgui:/app/con[0]/ses[2]");
  check("tree double-click", r.text.includes("fake: DoubleClickNode [          3] in"));
  r = await act({ do: "tree", id: tree, node: "4", how: "expand" }, "sapgui:/app/con[0]/ses[2]");
  check("tree expand shows the hidden node", r.text.includes("Hidden under a closed folder  {node 5}"));
  r = await act({ do: "grid", id: "wnd[0]/usr/cntlGRID1/shellcont/shell", row: 2, col: "VBELN", how: "double" }, "VA05");
  check("grid double-click", r.text.includes("fake: DoubleClickCurrentCell 2,VBELN in"));
  r = await act({ do: "f4", id: "ctxtVBAK-AUART" }, "sapgui:/app/con[0]/ses[5]");
  check("F4 on a field", r.text.includes("fake: SendVKey 4 on wnd[1] focus wnd[0]/usr/ctxtVBAK-AUART"));
  r = await act({ do: "dblclick", id: "wnd[1]/usr/lbl[1,3]" }, "sapgui:/app/con[0]/ses[5]");
  check("pick in the value help", r.text.includes("fake: SendVKey 2 on wnd[1] focus wnd[1]/usr/lbl[1,3]"));
  r = await act({ do: "okcode", value: "/nVA05" }, "sapgui:/app/con[0]/ses[0]");
  check("okcode", r.text.includes("fake: SendVKey 0 on wnd[0] okcode /nVA05"));

  for (const action of [{ do: "key", key: 11 }, { do: "okcode", value: "/11" }, { do: "press", id: "wnd[0]/tbar[0]/btn[11]" }, { do: "select", id: "wnd[0]/mbar/menu[0]/menu[1]" }]) {
    r = await act(action, "sapgui:/app/con[0]/ses[0]");
    check(`Save is refused: ${JSON.stringify(action)}`, r.error && r.text.startsWith("Refused:"), r.text.split("\n")[0]);
  }
  r = await act({ do: "press", id: "btnSPOP-OPTION1" }, "sapgui:/app/con[0]/ses[6]");
  check('"Yes" on the save popup is refused', r.error && r.text.includes("on the popup"), r.text.split("\n")[0]);
  r = await call("sap_look", { session: "sapgui:/app/con[0]/ses[0]" });
  check("nothing reached SAP GUI after the refusals", r.text.includes("fake: SendVKey 0 on wnd[0] okcode /nVA05"));
  r = await act({ do: "press", id: "btnNOPE" });
  check("unknown control", r.error && r.text.includes('No control "btnNOPE"'));
  r = await call("sap_screenshot");
  check("sap_screenshot", !r.error && r.text.includes("image/png"), r.text);
}
await client.close();
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);

import { describe, expect, test } from "bun:test";
import { decide, policyFromEnv } from "../../src/core/guard.js";
import { Registry } from "../../src/core/registry.js";
import { ActionError } from "../../src/core/types.js";
import type { DoctorEngine, DoctorLocal, Transport } from "../../src/sapgui/facts.js";
import { HostError } from "../../src/sapgui/host.js";
import type { Screen, SessionsFacts } from "../../src/sapgui/facts.js";
import { actTimeoutMs, doctor, policyCheck, sapguiSurface, SCRIPTING_OFF } from "../../src/sapgui/index.js";
import { expected, fakeHost, sessions } from "./fixtures.js";

/** A host with one session that shows `screen`; it records what it was asked, with the time limit. */
function oneScreen(screen: Screen) {
  const asked: { op: string; params: Record<string, unknown>; timeoutMs: number | undefined }[] = [];
  const host: Transport = {
    async request<T>(op: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
      asked.push({ op, params, timeoutMs });
      if (op === "screen") return screen as T;
      if (op === "describe") return { found: false } as T;
      return { done: true } as T;
    },
    close() {},
  };
  const surface = sapguiSurface({}, { platform: "win32", transport: host });
  return { asked, open: () => surface.open({ id: "sapgui:/app/con[0]/ses[0]", surface: "sapgui", where: "test" }) };
}

const win = (controls: Screen["windows"][number]["controls"]) => [{ id: "wnd[0]", title: "SAP", controls }];
const LOGON: Screen = {
  transaction: "S000",
  program: "SAPMSYST",
  screen: "20",
  language: "EN",
  activeWindow: "wnd[0]",
  windows: win([
    { id: "wnd[0]/tbar[0]/btn[0]", type: "GuiButton", name: "btn[0]", text: "", tip: "Enter   (Enter)", changeable: true },
    { id: "wnd[0]/usr/txtRSYST-BNAME", type: "GuiTextField", name: "RSYST-BNAME", text: "", changeable: true, label: "User" },
    { id: "wnd[0]/usr/pwdRSYST-BCODE", type: "GuiPasswordField", name: "RSYST-BCODE", changeable: true, label: "Password" },
  ]),
};
const START_MENU: Screen = { ...LOGON, screen: "40", windows: win([{ id: "wnd[0]/tbar[0]/btn[0]", type: "GuiButton", name: "btn[0]", text: "", tip: "Enter   (Enter)", changeable: true }]) };
const FORM: Screen = {
  transaction: "ZT01",
  program: "ZPROG",
  screen: "100",
  language: "EN",
  activeWindow: "wnd[0]",
  windows: win([
    { id: "wnd[0]/tbar[1]/btn[8]", type: "GuiButton", name: "btn[8]", text: "Execute", tip: "Execute   (F8)", changeable: true },
    { id: "wnd[0]/usr/txtZ-NAME", type: "GuiTextField", name: "Z-NAME", text: "", changeable: true, label: "Name" },
    { id: "wnd[0]/usr/pwdZ-SECRET", type: "GuiPasswordField", name: "Z-SECRET", changeable: true, label: "Secret" },
    { id: "wnd[0]/usr/pwdZ-ODD", type: "GuiTextField", name: "Z-ODD", text: "", changeable: true, label: "Odd" },
    { id: "wnd[0]/usr/btnZ-POST", type: "GuiButton", name: "Z-POST", text: "Post", tip: "", changeable: true },
    { id: "wnd[0]/usr/chkZ-FLAG", type: "GuiCheckBox", name: "Z-FLAG", text: "Flag", selected: false, changeable: true },
    { id: "wnd[0]/usr/tabsTS/tabpT1", type: "GuiTab", name: "T1", text: "One" },
    { id: "wnd[0]/usr/cntlED/shellcont/shell", type: "GuiShell", name: "shell", sub: "TextEdit", text: "" },
  ]),
};

function surface() {
  const { host, asked } = fakeHost();
  return { surface: sapguiSurface({}, { platform: "win32", transport: host }), asked };
}

describe("sapgui surface", () => {
  test("outside Windows it finds nothing and says why", async () => {
    const s = sapguiSurface({}, { platform: "linux" });
    expect(await s.discover()).toEqual([]);
    const checks = await s.doctor();
    expect(checks).toHaveLength(1);
    expect(checks[0]?.ok).toBe(false);
    expect(checks[0]?.detail).toContain("needs Windows");
  });

  test("discovery lists every session, the user's own first", async () => {
    const found = await surface().surface.discover();
    expect(found).toHaveLength(8);
    expect(found[0]).toEqual({
      id: "sapgui:/app/con[0]/ses[1]",
      surface: "sapgui",
      where: "SAP GUI DEM demo system, session 2",
      system: "DEM",
      client: "100",
      user: "TESTER",
      transaction: "VA03",
      title: "Display Standard Order 4711: Overview",
    });
    expect(found[1]?.id).toBe("sapgui:/app/con[0]/ses[0]");
  });

  test("no SAP GUI running is an empty list, not an error", async () => {
    const host: Transport = { request: async () => Promise.reject(new HostError("NO_SAPGUI: SAP GUI is not running")), close() {} };
    expect(await sapguiSurface({}, { platform: "win32", transport: host }).discover()).toEqual([]);
  });

  test("SAP GUI running with scripting off is an error the session list can show", async () => {
    const failing = (error: string): Transport => ({ request: async () => Promise.reject(new HostError(error)), close() {} });
    for (const error of ["SCRIPTING_OFF: SAP GUI is running but does not offer scripting", "NO_ENGINE: SAP GUI did not give its scripting engine"])
      await expect(sapguiSurface({}, { platform: "win32", transport: failing(error) }).discover()).rejects.toThrow(
        "SAP GUI is running but scripting is off (in SAP GUI options, or sapgui/user_scripting on the server)",
      );
    expect(SCRIPTING_OFF).toBe("SAP GUI is running but scripting is off (in SAP GUI options, or sapgui/user_scripting on the server)");
  });

  test("connections without a session that scripting can see: the server has scripting off", async () => {
    const facts: SessionsFacts = { active: "", connections: [{ id: "/app/con[0]", description: "PRD", disabledByServer: true, sessions: [] }] };
    const host: Transport = { request: async <T>() => facts as T, close() {} };
    await expect(sapguiSurface({}, { platform: "win32", transport: host }).discover()).rejects.toThrow(SCRIPTING_OFF);
    // One system that allows scripting next to one that does not: the sessions are listed.
    const mixed: Transport = { request: async <T>() => sessions() as T, close() {} };
    expect(await sapguiSurface({}, { platform: "win32", transport: mixed }).discover()).toHaveLength(8);
    // SAP Logon open, logged on nowhere: nothing to list, nothing wrong.
    const none: Transport = { request: async <T>() => ({ active: "", connections: [] }) as T, close() {} };
    expect(await sapguiSurface({}, { platform: "win32", transport: none }).discover()).toEqual([]);
  });

  test("the registry shows the scripting-off error instead of 'no session'", async () => {
    const host: Transport = { request: async () => Promise.reject(new HostError("SCRIPTING_OFF: x")), close() {} };
    const registry = new Registry([sapguiSurface({}, { platform: "win32", transport: host })], policyFromEnv({}));
    const found = await registry.discover();
    expect(found.sessions).toEqual([]);
    expect(found.errors.join(" ")).toContain(SCRIPTING_OFF);
  });

  test("look: full is the view in fixtures/expected, compact is shorter", async () => {
    const { surface: s } = surface();
    const [info] = await s.discover();
    const d = await s.open(info!);
    expect(await d.look({ compact: false })).toBe(expected("va03"));
    const short = await d.look({ compact: true });
    expect(short).toContain("row 0: Item=10; Material=M-01; Order Quantity=5");
    expect(short.length).toBeLessThan(expected("va03").length);
  });

  test("actions go to the host with the full id", async () => {
    const { surface: s, asked } = surface();
    const all = await s.discover();
    const va01 = await s.open(all.find((x) => x.transaction === "VA01" && x.id.endsWith("ses[0]"))!);
    expect(await va01.act({ do: "set", id: "VBAK-AUART", value: "RE" })).toBe('set wnd[0]/usr/ctxtVBAK-AUART = "RE"');
    expect(asked.at(-1)).toEqual({ op: "act", params: { session: "/app/con[0]/ses[0]", action: { do: "set", id: "wnd[0]/usr/ctxtVBAK-AUART", value: "RE" } } });
    await va01.act({ do: "okcode", value: "/nVA03" });
    expect(asked.at(-1)?.params.action).toEqual({ do: "okcode", value: "/nVA03" });
    await va01.act({ do: "key", key: 0 });
    expect(asked.at(-1)?.params.action).toEqual({ do: "key", key: 0 });

    const va03 = await s.open(all[0]!);
    await va03.act({ do: "combo", id: "cmbVBAK-LIFSK", key: "Credit limit" });
    expect(asked.at(-1)?.params.action).toMatchObject({ do: "combo", key: "01" });
    await va03.act({ do: "select", id: "wnd[0]/usr/tabsWRONG/tabpT\\02" });
    expect(asked.at(-1)?.params.action).toEqual({ do: "select", id: "wnd[0]/usr/tabsTAXI_TABSTRIP_OVERVIEW/tabpT\\02" });

    const va05 = await s.open(all.find((x) => x.transaction === "VA05")!);
    await va05.act({ do: "dblclick", id: "shell", row: 2, col: "VBELN" });
    expect(asked.at(-1)?.params.action).toEqual({ do: "grid", id: "wnd[0]/usr/cntlGRID1/shellcont/shell", row: 2, col: "VBELN", how: "double" });
  });

  test("an action that cannot run tells the model why", async () => {
    const { surface: s } = surface();
    const d = await s.open((await s.discover())[0]!);
    await expect(d.act({ do: "press", id: "btnNOPE" })).rejects.toBeInstanceOf(ActionError);
    await expect(d.act({ do: "press" })).rejects.toThrow('needs "id"');
    await expect(d.act({ do: "combo", id: "cmbVBAK-LIFSK", key: "99" })).rejects.toThrow("Entries:");
    await expect(d.act({ do: "fly", id: "chkVBAK-AUTLF" })).rejects.toThrow("Unknown action");
    const gone = await s.open({ id: "sapgui:/app/con[3]/ses[0]", surface: "sapgui", where: "" });
    await expect(gone.look({ compact: true })).rejects.toThrow("session is closed");
  });

  test("Save is refused while writes are off, in every form", async () => {
    const { surface: s, asked } = surface();
    const d = await s.open((await s.discover())[0]!);
    const policy = policyFromEnv({});
    for (const action of [
      { do: "key", key: 11 },
      { do: "okcode", value: "/11" },
      { do: "press", id: "wnd[0]/tbar[0]/btn[11]" },
      { do: "select", id: "wnd[0]/mbar/menu[0]/menu[1]" },
    ]) {
      const a = await d.assess(action);
      expect(a.risk).toBe("commit");
      expect(decide(policy, action, a)).toMatchObject({ run: false });
    }
    expect(decide(policy, { do: "key", key: 0 }, await d.assess({ do: "key", key: 0 }))).toEqual({ run: true });
    expect(asked.some((x) => x.op === "act")).toBe(false);
  });

  test("on the logon screen every action is refused, in assess and in act", async () => {
    const { asked, open } = oneScreen(LOGON);
    const d = await open();
    const actions = [
      { do: "set", id: "txtRSYST-BNAME", value: "ME" },
      { do: "set", id: "pwdRSYST-BCODE", value: "secret" },
      { do: "key", key: 0 },
      { do: "press", id: "wnd[0]/tbar[0]/btn[0]" },
      { do: "okcode", value: "/nVA03" },
      { do: "focus", id: "txtRSYST-BNAME" },
    ];
    for (const action of actions) {
      await expect(d.assess(action)).rejects.toThrow("This server never logs on; log on yourself, then ask again");
      await expect(d.act(action)).rejects.toThrow("This server never logs on; log on yourself, then ask again");
      await expect(d.act(action)).rejects.toBeInstanceOf(ActionError);
    }
    expect(asked.some((x) => x.op === "act")).toBe(false);
    // Looking is allowed, and shows no password.
    expect(await d.look({ compact: false })).toContain('pwdRSYST-BCODE  field  Password = ""');
  });

  test("the start menu of the same program is not the logon screen", async () => {
    const { asked, open } = oneScreen(START_MENU);
    const d = await open();
    expect((await d.assess({ do: "okcode", value: "va03" })).risk).toBe("navigate");
    await d.act({ do: "okcode", value: "/nVA03" });
    expect(asked.at(-1)?.op).toBe("act");
  });

  test("a password field is never typed into", async () => {
    const { asked, open } = oneScreen(FORM);
    const d = await open();
    await expect(d.act({ do: "set", id: "pwdZ-SECRET", value: "x" })).rejects.toThrow("password field: this server never types a password");
    await expect(d.act({ do: "set", id: "Z-SECRET", value: "x" })).rejects.toThrow("password field");
    // By the id's prefix too, whatever type the field reports.
    await expect(d.act({ do: "set", id: "wnd[0]/usr/pwdZ-ODD", value: "x" })).rejects.toThrow("password field");
    expect(asked.some((x) => x.op === "act")).toBe(false);
  });

  test("set types into fields only: a button is not pressed by it", async () => {
    const { asked, open } = oneScreen(FORM);
    const d = await open();
    await expect(d.act({ do: "set", id: "btnZ-POST", value: " " })).rejects.toThrow('not a field: "set" types into fields only');
    await expect(d.act({ do: "set", id: "tabpT1", value: "x" })).rejects.toThrow("not a field");
    await expect(d.act({ do: "check", id: "btnZ-POST", value: true })).rejects.toThrow("not a checkbox");
    await expect(d.act({ do: "combo", id: "btnZ-POST", key: "A" })).rejects.toThrow("not a dropdown");
    await expect(d.act({ do: "press", id: "txtZ-NAME" })).rejects.toThrow("not a button");
    expect(asked.some((x) => x.op === "act")).toBe(false);
    // Fields, a text editor, and a checkbox by its own action still work.
    expect(await d.act({ do: "set", id: "txtZ-NAME", value: "A" })).toBe('set wnd[0]/usr/txtZ-NAME = "A"');
    expect(await d.act({ do: "set", id: "wnd[0]/usr/cntlED/shellcont/shell", value: "text" })).toBe("set wnd[0]/usr/cntlED/shellcont/shell");
    await d.act({ do: "set", id: "chkZ-FLAG", value: true });
    expect(asked.at(-1)?.params.action).toEqual({ do: "check", id: "wnd[0]/usr/chkZ-FLAG", value: true });
  });

  test("select with row selects a row of a table control or a grid (the MM03 Select View(s) popup)", async () => {
    // Live, 2026-11-20: {"do":"select","id":"tblSAPLMGMMTC_VIEW","row":0} reached SAP GUI as Select() on the
    // table control, which has no such method (DISP_E_UNKNOWNNAME); the agent fell back to Select All.
    const views: Screen = {
      ...FORM,
      windows: win([
        { id: "wnd[0]/usr/tblSAPLMGMMTC_VIEW", type: "GuiTableControl", name: "SAPLMGMMTC_VIEW", rowCount: 43, visibleRowCount: 17, firstRow: 0, columns: ["View"] },
        { id: "wnd[0]/usr/cntlGRID1/shellcont/shell", type: "GuiShell", name: "shell", sub: "GridView" },
      ]),
    };
    const { asked, open } = oneScreen(views);
    const d = await open();
    expect(await d.act({ do: "select", id: "tblSAPLMGMMTC_VIEW", row: 0 })).toBe("selected row 0 of wnd[0]/usr/tblSAPLMGMMTC_VIEW");
    expect(asked.at(-1)?.params.action).toEqual({ do: "selectrow", id: "wnd[0]/usr/tblSAPLMGMMTC_VIEW", row: 0, value: true });
    await d.act({ do: "select", id: "tblSAPLMGMMTC_VIEW", row: 2, value: false });
    expect(asked.at(-1)?.params.action).toEqual({ do: "selectrow", id: "wnd[0]/usr/tblSAPLMGMMTC_VIEW", row: 2, value: false });
    await d.act({ do: "select", id: "cntlGRID1/shell", row: 5 });
    expect(asked.at(-1)?.params.action).toEqual({ do: "grid", id: "wnd[0]/usr/cntlGRID1/shellcont/shell", row: 5, col: "", how: "select" });
    // The grid action on a table control (what the agent tried next): a row selection, or a pointer to what works.
    await d.act({ do: "grid", id: "tblSAPLMGMMTC_VIEW", row: 1, col: "txtMSICHTAUSW-DYTXT", how: "select" });
    expect(asked.at(-1)?.params.action).toEqual({ do: "selectrow", id: "wnd[0]/usr/tblSAPLMGMMTC_VIEW", row: 1, value: true });
    const n = asked.length;
    await expect(d.act({ do: "select", id: "tblSAPLMGMMTC_VIEW", row: -1 })).rejects.toThrow('"row" is a row number');
    expect(asked.slice(n).some((x) => x.op === "act")).toBe(false);
  });

  test("select with row on a tab selects the tab", async () => {
    const { asked, open } = oneScreen(FORM);
    const d = await open();
    // A tab ignores "row": it is selected as a tab.
    await d.act({ do: "select", id: "tabpT1", row: 0 });
    expect(asked.at(-1)?.params.action).toMatchObject({ do: "select" });
  });

  test("reads get 60 s; an action 180 s, or its own timeout up to 600 s", async () => {
    const { asked, open } = oneScreen(FORM);
    const d = await open();
    await d.look({ compact: true });
    expect(asked.at(-1)).toMatchObject({ op: "screen", timeoutMs: 60_000 });
    await d.act({ do: "key", key: 0 });
    expect(asked.at(-1)).toMatchObject({ op: "act", timeoutMs: 180_000 });
    await d.act({ do: "key", key: 8, timeout: 400 });
    expect(asked.at(-1)).toMatchObject({ op: "act", timeoutMs: 400_000, params: { action: { do: "key", key: 8 } } });
    await d.act({ do: "press", id: "wnd[0]/tbar[1]/btn[8]", timeout: 5000 });
    expect(asked.at(-1)).toMatchObject({ op: "act", timeoutMs: 600_000 });
    expect(actTimeoutMs({ do: "key", key: 8, timeout: "x" })).toBe(180_000);
    expect(actTimeoutMs({ do: "key", key: 8, timeout: -1 })).toBe(180_000);
    expect(actTimeoutMs({ do: "key", key: 8, timeout: 30 })).toBe(30_000);
  });

  test("a key by its name is the same key for the guard and for SAP GUI", async () => {
    const { asked, open } = oneScreen(FORM);
    const d = await open();
    expect((await d.assess({ do: "key", key: "Control+s" })).risk).toBe("commit");
    await d.act({ do: "key", key: "Shift+F3" });
    expect(asked.at(-1)?.params.action).toEqual({ do: "key", key: 15 });
    await expect(d.act({ do: "key", key: "Space" })).rejects.toThrow('Space has no virtual key in SAP GUI, and the cursor is not in a table row');
    await expect(d.act({ do: "key", key: "Alt+Q" })).rejects.toThrow('key needs "key"');
  });

  test("screenshot", async () => {
    const { surface: s } = surface();
    const d = await s.open((await s.discover())[0]!);
    expect((await d.screenshot()).toString()).toBe("PNG");
  });
});

describe("sapgui doctor", () => {
  const host = (local: DoctorLocal, engine: DoctorEngine): Transport => ({
    request: async <T>(op: string) => (op === "doctor-local" ? local : engine) as T,
    close() {},
  });
  const on = { value: 1, where: "HKCU" };
  const off = { value: 0, where: "HKCU" };

  test("Constrained Language Mode and AppLocker are detected and explained", async () => {
    const good = host({ processes: ["saplogon"], settings: { UserScripting: on, WarnOnAttach: off, WarnOnConnection: off } }, { engine: true, connections: [{ description: "DEM", disabledByServer: false, sessions: 2 }] });
    const constrained = await doctor(good, async () => ({ languageMode: "ConstrainedLanguage", appLocker: true }));
    expect(constrained).toHaveLength(1);
    expect(constrained[0]).toMatchObject({ ok: false, check: "PowerShell may run the host" });
    expect(constrained[0]?.detail).toContain("Constrained Language mode");
    expect(constrained[0]?.detail).toContain("AppLocker is active on this machine");
    expect(constrained[0]?.detail).toContain("Full Language mode");
    expect(constrained[0]?.detail).toContain("Web GUI or Fiori");

    const blocked = await doctor(good, async () => ({ languageMode: "", appLocker: false, error: "This program is blocked by group policy. For more information, contact your system administrator." }));
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.ok).toBe(false);
    expect(blocked[0]?.detail).toContain("AppLocker or a software restriction policy");

    const full = await doctor(good, async () => ({ languageMode: "FullLanguage", appLocker: true }));
    expect(full.map((c) => c.ok)).toEqual([true, true, true, true, true, true]);
    expect(full[0]?.detail).toBe("Full Language mode; AppLocker is active and allows it");

    // PowerShell could not be asked for another reason: the host's own failure says why.
    expect(policyCheck({ languageMode: "", appLocker: false, error: "spawn powershell.exe ENOENT" })).toBeUndefined();
    // The probe failed but the host runs and reports a restricted mode itself.
    const late = await doctor(host({ languageMode: "ConstrainedLanguage", processes: [], settings: {} }, { engine: false, connections: [] }), async () => undefined);
    expect(late.find((c) => c.check === "PowerShell may run the host")).toMatchObject({ ok: false });
  });

  test("all good", async () => {
    const checks = await doctor(
      host(
        { processes: ["saplogon"], settings: { UserScripting: on, WarnOnAttach: off, WarnOnConnection: off } },
        { engine: true, connections: [{ description: "DEM", disabledByServer: false, sessions: 2 }] },
      ),
    );
    expect(checks.map((c) => c.ok)).toEqual([true, true, true, true, true]);
  });

  test("SAP GUI not running", async () => {
    const checks = await doctor(host({ processes: [], settings: { UserScripting: null, WarnOnAttach: null, WarnOnConnection: null } }, { engine: false, connections: [] }));
    expect(checks[0]).toMatchObject({ ok: false, check: "SAP GUI is running" });
    expect(checks[0]?.detail).toContain("start SAP Logon");
  });

  test("scripting off in the client", async () => {
    const checks = await doctor(host({ processes: ["saplogon"], settings: { UserScripting: off, WarnOnAttach: off, WarnOnConnection: off } }, { engine: false, error: "no engine", connections: [] }));
    expect(checks[1]?.ok).toBe(false);
    expect(checks[1]?.detail).toContain("Enable scripting");
  });

  test("scripting off on the server", async () => {
    const checks = await doctor(
      host(
        { processes: ["saplogon"], settings: { UserScripting: on, WarnOnAttach: off, WarnOnConnection: off } },
        { engine: true, connections: [{ description: "PRD", disabledByServer: true, sessions: 0 }] },
      ),
    );
    expect(checks[2]?.ok).toBe(false);
    expect(checks[2]?.detail).toContain("sapgui/user_scripting = TRUE");
  });

  test("notices on", async () => {
    const checks = await doctor(
      host(
        { processes: ["saplogon"], settings: { UserScripting: on, WarnOnAttach: null, WarnOnConnection: { value: 1, where: "HKLM" } } },
        { engine: true, connections: [{ description: "DEM", disabledByServer: false, sessions: 1 }] },
      ),
    );
    expect(checks[3]?.ok).toBe(false);
    expect(checks[3]?.detail).toContain("Notify when a script attaches");
    expect(checks[4]?.ok).toBe(false);
    expect(checks[4]?.detail).toContain("administrator");
  });
});

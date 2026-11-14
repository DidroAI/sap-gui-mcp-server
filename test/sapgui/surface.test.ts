import { describe, expect, test } from "bun:test";
import { decide, policyFromEnv } from "../../src/core/guard.js";
import { ActionError } from "../../src/core/types.js";
import type { DoctorEngine, DoctorLocal, Transport } from "../../src/sapgui/facts.js";
import { HostError } from "../../src/sapgui/host.js";
import { doctor, sapguiSurface } from "../../src/sapgui/index.js";
import { expected, fakeHost } from "./fixtures.js";

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

  test("look: full is the bridge's view, compact is shorter", async () => {
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

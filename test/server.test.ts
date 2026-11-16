import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { policyFromEnv } from "../src/core/guard.js";
import type { Action, Assessment } from "../src/core/types.js";
import { createServer, statusTop, withStatus } from "../src/server.js";
import { FakeSurface } from "./fakes.js";

/** Save (key 11) commits; everything else navigates. */
const assess = (a: Action): Assessment => (a.do === "key" && a.key === 11 ? { risk: "commit", reason: "key 11: Save" } : { risk: "navigate", reason: a.do });

interface Ask {
  message: string;
}

async function setup(env: Record<string, string> = {}, elicit?: (ask: Ask) => "accept" | "decline" | "cancel" | Promise<"accept" | "decline" | "cancel">) {
  const surface = new FakeSurface("webgui");
  const { server } = createServer({ policy: policyFromEnv(env), surfaces: [surface] });
  const client = new Client({ name: "test", version: "0" }, { capabilities: elicit ? { elicitation: {} } : {} });
  const asked: Ask[] = [];
  if (elicit)
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const ask = { message: (request.params as { message: string }).message };
      asked.push(ask);
      return { action: await elicit(ask) };
    });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string }[] };
    return { error: r.isError === true, text: r.content.map((c) => c.text ?? `<${c.type}>`).join("\n") };
  };
  return { surface, client, call, asked };
}

const tokenOf = (text: string) => /token "([0-9a-f]+)"/.exec(text)?.[1] ?? "";

describe("one normalised action for assess and act", () => {
  test('{"do":"key","value":11} is Save to the guard, not "no key"', async () => {
    const { surface, call } = await setup();
    surface.add({ id: "chrome:1", system: "ABA", client: "800", transaction: "VA02" }, { assess });
    const r = await call("sap_act", { action: { do: "key", value: 11 } });
    expect(r.error).toBe(true);
    expect(r.text).toContain("writes are off");
    expect(surface.acts()).toEqual([]);
    // What assess saw is the normalised shape.
    expect(surface.log[0]).toEqual({ op: "assess", action: { do: "key", key: 11 } });
  });
  test("assess and act receive the very same object", async () => {
    const { surface, call } = await setup();
    surface.add({ id: "chrome:1", system: "ABA" }, { assess });
    await call("sap_act", { action: { do: " SET ", id: "ctxtA\n", value: "OR\r\n" } });
    const [a, b] = surface.log;
    expect(a?.op).toBe("assess");
    expect(b?.op).toBe("act");
    expect(a?.action).toBe(b?.action as Action);
    expect(b?.action).toEqual({ do: "set", id: "ctxtA", value: "OR" });
  });
  test("an unknown do or key never reaches a surface", async () => {
    const { surface, call } = await setup({ SAP_WRITE: "on" });
    surface.add({ id: "chrome:1", system: "ABA" });
    for (const action of [{ do: "eval", id: "x" }, { do: "key", key: "save" }, { do: "key", key: 250 }, { do: "set", id: "x", value: { a: 1 } }]) {
      const r = await call("sap_act", { action });
      expect([action, r.error]).toEqual([action, true]);
    }
    expect(surface.log).toEqual([]);
  });
});

describe("the command field", () => {
  test("typing into it is refused on any surface, before the surface is asked", async () => {
    const { surface, call } = await setup({ SAP_WRITE: "on", SAP_BLOCK_TCODES: "SE38" });
    surface.add({ id: "chrome:1", system: "ABA" });
    for (const action of [
      { do: "set", id: "wnd[0]/tbar[0]/okcd", value: "/nSE38" },
      { do: "set", id: "okcd", value: "/nSE38" },
      { do: "focus", id: "#ToolbarOkCode" },
      { do: "dblclick", id: "tbar[0]/okcd" },
    ]) {
      const r = await call("sap_act", { action });
      expect(r.error).toBe(true);
      expect(r.text).toContain('{"do":"okcode"');
    }
    expect(surface.log).toEqual([]);
  });
});

describe("the transaction a session is in", () => {
  test("an action that lands in a blocked transaction is reported and left with /n", async () => {
    const { surface, call } = await setup({ SAP_BLOCK_TCODES: "SE38" });
    surface.add(
      { id: "chrome:1", system: "ABA", transaction: "SESSION_MANAGER" },
      {
        onAct: (a, s) => {
          // A favourite in the menu tree opens SE38; /n goes back to the menu.
          if (a.do === "tree") s.info = { ...s.info, transaction: "SE38" };
          if (a.do === "okcode" && a.value === "/n") s.info = { ...s.info, transaction: "SESSION_MANAGER" };
        },
      },
    );
    const r = await call("sap_act", { action: { do: "tree", id: "shell", node: "F00004", how: "double" } });
    expect(r.error).toBe(true);
    expect(r.text).toContain("transaction SE38 is blocked (SAP_BLOCK_TCODES)");
    expect(r.text).toContain("left it with /n");
    expect(surface.acts()).toEqual([
      { do: "tree", id: "shell", node: "F00004", how: "double" },
      { do: "okcode", value: "/n" },
    ]);
    expect(r.text).toContain("SCREEN SESSION_MANAGER");
  });
  test("a session already in a blocked transaction takes only actions that leave it", async () => {
    const { surface, call } = await setup({ SAP_ALLOW_TCODES: "VA03" });
    surface.add(
      { id: "chrome:1", system: "ABA", transaction: "MM02" },
      {
        onAct: (a, s) => {
          if (a.do === "okcode") s.info = { ...s.info, transaction: String(a.value).replace(/^\/n/, "") || "SESSION_MANAGER" };
        },
      },
    );
    const refused = await call("sap_act", { action: { do: "set", id: "ctxtRMMG1-MATNR", value: "M-01" } });
    expect(refused.error).toBe(true);
    expect(refused.text).toContain("transaction MM02 is not in SAP_ALLOW_TCODES");
    expect(surface.log).toEqual([]);
    expect((await call("sap_act", { action: { do: "okcode", value: "/nMM03" } })).error).toBe(true);
    const ok = await call("sap_act", { action: { do: "okcode", value: "/nVA03" } });
    expect(ok.error).toBe(false);
    expect(ok.text).toContain("SCREEN VA03");
    // Now in VA03, ordinary actions run.
    expect((await call("sap_act", { action: { do: "set", id: "ctxtVBAK-VBELN", value: "4711" } })).error).toBe(false);
  });
  test("the start menu is not refused by an allow list", async () => {
    const { surface, call } = await setup({ SAP_ALLOW_TCODES: "VA03" });
    surface.add({ id: "chrome:1", system: "ABA", transaction: "SESSION_MANAGER" });
    expect((await call("sap_act", { action: { do: "key", key: 0 } })).error).toBe(false);
  });
});

describe("systems on every tool", () => {
  test("look, screenshot, use and act refuse a session that left the allowed systems", async () => {
    const { surface, call } = await setup({ SAP_ALLOW_SYSTEMS: "ABA/800" });
    const s = surface.add({ id: "chrome:1", system: "ABA", client: "800", title: "Sales" });
    expect((await call("sap_look")).text).toContain("SCREEN");
    s.info = { ...s.info, system: "PRD", client: "100" };
    surface.log.length = 0;
    for (const [tool, args] of [
      ["sap_look", {}],
      ["sap_screenshot", {}],
      ["sap_use", { session: "chrome:1" }],
      ["sap_act", { action: { do: "key", key: 0 } }],
    ] as const) {
      const r = await call(tool, args);
      expect([tool, r.error]).toEqual([tool, true]);
      expect(r.text).toContain("outside SAP_ALLOW_SYSTEMS");
    }
    expect(surface.log).toEqual([]);
  });
});

describe("confirm mode with a token", () => {
  const env = { SAP_WRITE: "confirm" };
  test("the token runs the action when nothing changed, once", async () => {
    const { surface, call } = await setup(env);
    surface.add({ id: "chrome:1", system: "ABA", client: "800", transaction: "VA02", title: "Change Order 4711" }, { assess });
    const held = await call("sap_act", { action: { do: "key", value: 11 } });
    expect(held.error).toBe(false);
    expect(held.text).toContain("key 11: Save");
    expect(held.text).toContain("ABA/800, VA02");
    expect(held.text).toContain('{"do":"key","key":11}');
    expect(surface.acts()).toEqual([]);
    const token = tokenOf(held.text);
    expect(token).toMatch(/^[0-9a-f]{12}$/);
    const done = await call("sap_confirm", { token });
    expect(done.error).toBe(false);
    expect(surface.acts()).toEqual([{ do: "key", key: 11 }]);
    expect((await call("sap_confirm", { token })).text).toContain("Unknown or expired token");
    expect(surface.acts()).toHaveLength(1);
  });
  for (const [what, change, says] of [
    ["transaction", { transaction: "VA01" }, 'transaction was "VA02", is now "VA01"'],
    ["window title", { title: "Change Order 9999" }, 'window title was "Change Order 4711", is now "Change Order 9999"'],
    ["system", { system: "ABB" }, 'system was "ABA", is now "ABB"'],
    ["client", { client: "100" }, 'client was "800", is now "100"'],
  ] as const)
    test(`a changed ${what} refuses the token`, async () => {
      const { surface, call } = await setup(env);
      const s = surface.add({ id: "chrome:1", system: "ABA", client: "800", transaction: "VA02", title: "Change Order 4711" }, { assess });
      const token = tokenOf((await call("sap_act", { action: { do: "key", key: 11 } })).text);
      s.info = { ...s.info, ...change };
      const r = await call("sap_confirm", { token });
      expect(r.error).toBe(true);
      expect(r.text).toContain(says);
      expect(surface.acts()).toEqual([]);
      // The token is spent: putting the screen back does not revive it.
      s.info = { ...s.info, transaction: "VA02", title: "Change Order 4711", system: "ABA", client: "800" };
      expect((await call("sap_confirm", { token })).error).toBe(true);
      expect(surface.acts()).toEqual([]);
    });
  test("a changed assessment refuses the token", async () => {
    const { surface, call } = await setup(env);
    const s = surface.add({ id: "chrome:1", system: "ABA", transaction: "VA02", title: "T" }, { assess });
    const token = tokenOf((await call("sap_act", { action: { do: "key", key: 11 } })).text);
    // Same screen title, but a popup now makes the key mean something else.
    s.assess = () => ({ risk: "commit", reason: 'key 11: button "Delete"' });
    const r = await call("sap_confirm", { token });
    expect(r.error).toBe(true);
    expect(r.text).toContain("what the action does");
    expect(surface.acts()).toEqual([]);
  });
  test("a token belongs to its session, whichever is active", async () => {
    const { surface, call } = await setup(env);
    surface.add({ id: "chrome:1", system: "ABA", transaction: "VA02", title: "One" }, { assess });
    surface.add({ id: "chrome:2", system: "ABA", transaction: "VA02", title: "Two" }, { assess });
    const token = tokenOf((await call("sap_act", { action: { do: "key", key: 11 }, session: "chrome:1" })).text);
    await call("sap_use", { session: "chrome:2" });
    surface.log.length = 0;
    expect((await call("sap_confirm", { token })).error).toBe(false);
    expect(surface.acts()).toEqual([{ do: "key", key: 11 }]);
    // The act went to session 1: its screen is what came back.
  });
  test("a token whose session is gone runs nothing", async () => {
    const { surface, call } = await setup(env);
    surface.add({ id: "chrome:1", system: "ABA", transaction: "VA02" }, { assess });
    const other = surface.add({ id: "chrome:2", system: "ABA", transaction: "VA02" }, { assess });
    const token = tokenOf((await call("sap_act", { action: { do: "key", key: 11 }, session: "chrome:1" })).text);
    surface.sessions = [other];
    expect((await call("sap_confirm", { token })).error).toBe(true);
    expect(surface.acts()).toEqual([]);
  });
  test("the tool descriptions say the token flow is advisory", async () => {
    const { client } = await setup(env);
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === "sap_confirm")?.description).toContain("advisory");
  });
});

describe("confirm mode with elicitation", () => {
  const env = { SAP_WRITE: "confirm" };
  test("the user accepts in the client: the action runs, no token", async () => {
    const { surface, call, asked } = await setup(env, () => "accept");
    surface.add({ id: "chrome:1", system: "ABA", client: "800", transaction: "VA02", title: "Change Order 4711" }, { assess });
    const r = await call("sap_act", { action: { do: "key", key: 11 } });
    expect(r.error).toBe(false);
    expect(r.text).toContain("did key");
    expect(r.text).not.toContain("token");
    expect(surface.acts()).toEqual([{ do: "key", key: 11 }]);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.message).toContain("key 11: Save");
    expect(asked[0]?.message).toContain("ABA/800, VA02");
    expect(asked[0]?.message).toContain('{"do":"key","key":11}');
  });
  test("the user declines or dismisses: nothing runs", async () => {
    for (const answer of ["decline", "cancel"] as const) {
      const { surface, call } = await setup(env, () => answer);
      surface.add({ id: "chrome:1", system: "ABA", transaction: "VA02" }, { assess });
      const r = await call("sap_act", { action: { do: "key", key: 11 } });
      expect(r.text).toContain("Not run");
      expect(surface.acts()).toEqual([]);
    }
  });
  test("the screen changes while the user reads: nothing runs", async () => {
    const box: { s?: ReturnType<FakeSurface["add"]> } = {};
    const { surface, call } = await setup(env, () => {
      box.s!.info = { ...box.s!.info, transaction: "VA01" };
      return "accept";
    });
    box.s = surface.add({ id: "chrome:1", system: "ABA", transaction: "VA02" }, { assess });
    const r = await call("sap_act", { action: { do: "key", key: 11 } });
    expect(r.error).toBe(true);
    expect(r.text).toContain('transaction was "VA02", is now "VA01"');
    expect(surface.acts()).toEqual([]);
  });
  test("actions that need no confirmation do not ask", async () => {
    const { surface, call, asked } = await setup(env, () => "decline");
    surface.add({ id: "chrome:1", system: "ABA" }, { assess });
    expect((await call("sap_act", { action: { do: "key", key: 0 } })).error).toBe(false);
    expect(asked).toEqual([]);
  });
});

describe("session list", () => {
  test("shows the origin of browser sessions, and discovery errors", async () => {
    const { surface, call } = await setup();
    surface.add({ id: "chrome:1", system: "ABA", url: "https://myhost:44300/sap/bc/gui/sap/its/webgui", where: "Chrome tab 'SAP'" });
    expect((await call("sap_sessions")).text).toContain("origin=https://myhost:44300");
    surface.failWith = "No Chrome to attach to.";
    expect((await call("sap_sessions")).text).toContain("webgui: No Chrome to attach to.");
    const look = await call("sap_look");
    expect(look.error).toBe(true);
    expect(look.text).toContain("No Chrome to attach to.");
    expect(look.text).not.toContain("Open SAP GUI");
  });
  test("a surface name selects a session", async () => {
    const { surface, call } = await setup();
    surface.add({ id: "chrome:1", system: "ABA", transaction: "VA03" });
    expect((await call("sap_use", { session: "webgui" })).text).toContain("SCREEN VA03");
    expect((await call("sap_look", { session: "fiori" })).error).toBe(true);
  });
});

describe("one call at a time per session", () => {
  test("two actions sent together run one after the other, and the second says it waited", async () => {
    const { surface, call } = await setup();
    surface.add({ id: "chrome:1", system: "ABA", transaction: "VA03" }, { actMs: 150 });
    await call("sap_look");
    const [a, b] = await Promise.all([call("sap_act", { action: { do: "set", id: "ctxtA", value: "4990" } }), call("sap_act", { action: { do: "key", key: 0 } })]);
    const ops = surface.log.filter((l) => l.op !== "look").map((l) => `${l.op} ${l.action?.do}`);
    expect(ops).toEqual(["assess set", "act set", "act-end set", "assess key", "act key", "act-end key"]);
    expect(a.text).not.toContain("waited");
    expect(b.text.split("\n")[0]).toMatch(/^\(This call waited 0\.\d s for the call before it on this session \(\{"do":"set","id":"ctxtA","value":"4990"\}\)/);
  });

  test("a look waits for the action under way", async () => {
    const { surface, call } = await setup();
    surface.add({ id: "chrome:1", system: "ABA" }, { actMs: 150 });
    await call("sap_look");
    surface.log.length = 0;
    await Promise.all([call("sap_act", { action: { do: "key", key: 0 } }), call("sap_look")]);
    expect(surface.log.map((l) => l.op)).toEqual(["assess", "act", "act-end", "look", "look"]);
  });

  test("the first calls, before any session is known, queue too", async () => {
    const { surface, call } = await setup();
    surface.add({ id: "chrome:1", system: "ABA" }, { actMs: 100 });
    await Promise.all([call("sap_act", { action: { do: "set", id: "x", value: "1" } }), call("sap_act", { action: { do: "set", id: "y", value: "2" } })]);
    const ops = surface.log.filter((l) => l.op !== "look").map((l) => l.op);
    expect(ops).toEqual(["assess", "act", "act-end", "assess", "act", "act-end"]);
  });

  test("a failing action does not block the next one", async () => {
    const { surface, call } = await setup();
    const s = surface.add({ id: "chrome:1", system: "ABA" }, { actMs: 50, failAct: new Error("boom") });
    const [a, b] = await Promise.all([call("sap_act", { action: { do: "key", key: 0 } }), call("sap_act", { action: { do: "key", key: 3 } })]);
    expect([a.error, b.error]).toEqual([true, true]);
    delete s.failAct;
    expect((await call("sap_act", { action: { do: "key", key: 0 } })).error).toBe(false);
  });

  test("while the user is asked to confirm, the session is not held", async () => {
    let release!: () => void;
    const answered = new Promise<"accept">((r) => {
      release = () => r("accept");
    });
    const { surface, call } = await setup({ SAP_WRITE: "confirm" }, () => answered);
    surface.add({ id: "chrome:1", system: "ABA", transaction: "VA02" }, { assess });
    await call("sap_look");
    const save = call("sap_act", { action: { do: "key", key: 11 } });
    await new Promise((r) => setTimeout(r, 50));
    const look = await call("sap_look");
    expect(look.error).toBe(false);
    release();
    expect((await save).error).toBe(false);
    expect(surface.acts()).toEqual([{ do: "key", key: 11 }]);
  });
});

describe("the answer to an action", () => {
  test("an error in the status bar is said again when it did not change", () => {
    const view = "TRANSACTION VA03  PROGRAM SAPMV45A  SCREEN 102\nsbar  status  E: SD document 99999999 is not in the database";
    expect(withStatus("NO CHANGE on the screen (36 lines; sap_look shows it).", view)).toBe(
      "NO CHANGE on the screen (36 lines; sap_look shows it).\n= sbar  status  E: SD document 99999999 is not in the database",
    );
    expect(withStatus(`+ ${view.split("\n")[1]}`, view)).toBe(`+ ${view.split("\n")[1]}`);
    expect(withStatus("NO CHANGE", "x\nsbar  status  S: Order saved")).toBe("NO CHANGE");
  });

  test("a second Enter on the same error still names the error", async () => {
    const { surface, call } = await setup();
    surface.add({ id: "chrome:1", system: "ABA" }, { view: "TRANSACTION VA03  PROGRAM SAPMV45A  SCREEN 102\nctxtVBAK-VBELN  field  Order = \"9\"\nsbar  status  E: SD document 9 is not in the database" });
    await call("sap_look");
    const r = await call("sap_act", { action: { do: "key", key: 0 } });
    expect(r.text).toContain("NO CHANGE");
    expect(r.text).toContain("= sbar  status  E: SD document 9 is not in the database");
  });

  test("a warning or an error of the status bar is the second line of the answer, with what to do", async () => {
    const fields = Array.from({ length: 12 }, (_, i) => `ctxtZ-F${i}  field  F${i} = "v"  (edit)`);
    const before = ["TRANSACTION VA02  PROGRAM SAPMV45A  SCREEN 4001", ...fields].join("\n");
    const { surface, call } = await setup();
    const s = surface.add({ id: "chrome:1", system: "ABA" }, { view: before });
    await call("sap_look");
    s.view = [...before.replace(/\(edit\)/g, "(read-only)").split("\n"), "sbar  status  W: The default date is not copied into existing schedule lines"].join("\n");
    const lines = (await call("sap_act", { action: { do: "key", key: 0 } })).text.split("\n");
    expect(lines[1]).toBe("STATUS W: The default date is not copied into existing schedule lines  (warning: Enter accepts it and goes on; another warning may follow, and each takes its own Enter. SAP may keep the fields closed until then, and fills nothing in before)");
    expect(lines[2]).toBe("");
    // The fields the warning closed are one line, not twelve.
    expect(lines.length).toBeLessThan(8);
    expect(lines.join("\n")).toContain("~ 12 fields closed for input");
  });

  test("statusTop: nothing for a success message, or when the status line is already at the top of the answer", () => {
    const view = "TRANSACTION VA03  PROGRAM SAPMV45A  SCREEN 102\nsbar  status  E: SD document 9 is not in the database";
    expect(statusTop("NO CHANGE on the screen.\n= sbar  status  E: SD document 9 is not in the database", view)).toBeUndefined();
    expect(statusTop(view.replace("E: ", "S: "), view.replace("E: ", "S: "))).toBeUndefined();
    expect(statusTop(`${view.split("\n")[0]}\na\n${view.split("\n")[1]}`, view)).toBe(
      "STATUS E: SD document 9 is not in the database  (error: correct the input it names, then Enter)",
    );
  });

  test('"timing": true adds where the time went, and is not part of the action', async () => {
    const { surface, call } = await setup();
    surface.add({ id: "chrome:1", system: "ABA" }, { timing: "812 ms: sap 600, start 40, settle 150, wake 12, other 10 (1 request)" });
    const r = await call("sap_act", { action: { do: "key", key: 0, timing: true } });
    expect(r.text).toMatch(/\(timing: \d+ ms in the server: judge \d+, act \d+, answer \d+; the action 812 ms: sap 600, start 40/);
    expect(surface.acts()).toEqual([{ do: "key", key: 0 }]);
    expect((await call("sap_act", { action: { do: "key", key: 0 } })).text).not.toContain("timing");
  });
});

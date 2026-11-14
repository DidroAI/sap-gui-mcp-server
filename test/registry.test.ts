import { describe, expect, test } from "bun:test";
import { policyFromEnv } from "../src/core/guard.js";
import { Registry } from "../src/core/registry.js";
import { FakeSurface } from "./fakes.js";

function setup(env: Record<string, string> = {}) {
  const webgui = new FakeSurface("webgui");
  const fiori = new FakeSurface("fiori");
  return { webgui, fiori, registry: new Registry([webgui, fiori], policyFromEnv(env)) };
}

describe("systems (SAP_ALLOW_SYSTEMS)", () => {
  test("a session outside the list is not listed and cannot be opened", async () => {
    const { webgui, registry } = setup({ SAP_ALLOW_SYSTEMS: "ABA/800" });
    webgui.add({ id: "chrome:1", system: "ABA", client: "800" });
    webgui.add({ id: "chrome:2", system: "PRD", client: "100" });
    const found = await registry.discover();
    expect(found.sessions.map((s) => s.id)).toEqual(["chrome:1"]);
    expect(found.hidden).toBe(1);
    await expect(registry.driver("chrome:2")).rejects.toThrow(/No open SAP session matches/);
    expect(webgui.opened).toBe(0);
  });
  test("a session that moves to another system after discovery is refused on every use", async () => {
    const { webgui, registry } = setup({ SAP_ALLOW_SYSTEMS: "ABA" });
    const s = webgui.add({ id: "chrome:1", system: "ABA", client: "800" });
    expect((await registry.session()).info.system).toBe("ABA");
    // The same tab logs on to production: the driver is still open, the list still says ABA.
    s.info = { ...s.info, system: "PRD", client: "100" };
    await expect(registry.driver()).rejects.toThrow("System PRD/100 is outside SAP_ALLOW_SYSTEMS.");
    await expect(registry.driver("chrome:1")).rejects.toThrow(/outside SAP_ALLOW_SYSTEMS/);
    expect(webgui.log).toEqual([]);
  });
  test("a session whose system is unknown is refused when a list is set", async () => {
    const { webgui, registry } = setup({ SAP_ALLOW_SYSTEMS: "ABA" });
    const s = webgui.add({ id: "chrome:1", system: "ABA" });
    await registry.driver();
    s.info = { id: "chrome:1", surface: "webgui", where: "x" };
    await expect(registry.driver()).rejects.toThrow("System (unknown) is outside SAP_ALLOW_SYSTEMS.");
  });
});

describe("driver cache", () => {
  test("one driver per session, reused", async () => {
    const { webgui, registry } = setup();
    webgui.add({ id: "chrome:1", system: "ABA" });
    const a = await registry.driver();
    const b = await registry.driver("chrome:1");
    expect(a).toBe(b);
    expect(webgui.opened).toBe(1);
  });
  test("a driver that is no longer valid is dropped and the session opened again", async () => {
    const { webgui, registry } = setup();
    const s = webgui.add({ id: "chrome:1", system: "ABA" });
    const first = await registry.driver();
    // The browser connection dropped: the old driver's page is dead, the tab is still there after reconnecting.
    s.valid = false;
    webgui.sessions = [{ info: s.info }];
    const second = await registry.driver();
    expect(second).not.toBe(first);
    expect(webgui.opened).toBe(2);
    expect(await registry.driver()).toBe(second);
  });
  test("a driver whose refresh fails is opened again once", async () => {
    const { webgui, registry } = setup();
    const s = webgui.add({ id: "chrome:1", system: "ABA" });
    await registry.driver();
    s.broken = "Target closed";
    await expect(registry.driver()).rejects.toThrow("Target closed");
    expect(webgui.opened).toBe(2);
    delete s.broken;
    expect((await registry.session()).info.id).toBe("chrome:1");
  });
  test("the same tab id on another surface gets that surface's driver", async () => {
    const { webgui, fiori, registry } = setup();
    const s = webgui.add({ id: "chrome:T", system: "S4H", transaction: "VA03" });
    const first = await registry.session();
    expect(first.info.surface).toBe("webgui");
    // The tab goes to the launchpad: Web GUI no longer owns it, Fiori does, under the same id.
    webgui.sessions = [];
    s.valid = false;
    fiori.add({ id: "chrome:T", system: "S4H", transaction: "Shell-home" });
    const second = await registry.session();
    expect(second.info.surface).toBe("fiori");
    expect(second.driver).not.toBe(first.driver);
    expect(fiori.opened).toBe(1);
    // And back again: the Fiori driver is not handed out for a Web GUI tab.
    fiori.sessions = [];
    webgui.add({ id: "chrome:T", system: "S4H", transaction: "VA03" });
    const third = await registry.session("chrome:T");
    expect(third.info.surface).toBe("webgui");
    expect(webgui.opened).toBe(2);
  });
  test("a closed session says so", async () => {
    const { webgui, registry } = setup();
    webgui.add({ id: "chrome:1", system: "ABA" });
    await registry.driver();
    webgui.sessions = [];
    await expect(registry.driver()).rejects.toThrow(/No open SAP session/);
  });
});

describe("messages and references", () => {
  test("nothing found because discovery failed says why, once per cause", async () => {
    const { webgui, fiori, registry } = setup();
    webgui.failWith = "No Chrome to attach to.";
    fiori.failWith = "No Chrome to attach to.";
    const found = await registry.discover();
    expect(found.errors).toEqual(["webgui, fiori: No Chrome to attach to."]);
    expect(found.allFailed).toBe(true);
    const e = await registry.driver().catch((x: Error) => x.message);
    expect(e).toContain("No Chrome to attach to.");
    expect(e).not.toContain("Open SAP GUI");
    expect(await registry.driver("VA03").catch((x: Error) => x.message)).toContain("No Chrome to attach to.");
  });
  test("nothing found without errors keeps the plain hint; one surface failing is not all failing", async () => {
    const { fiori, registry } = setup();
    expect(await registry.driver().catch((x: Error) => x.message)).toContain("Open SAP GUI");
    fiori.failWith = "boom";
    expect((await registry.discover()).allFailed).toBe(false);
  });
  test("a surface name is a reference", async () => {
    const { webgui, fiori, registry } = setup();
    webgui.add({ id: "chrome:1", system: "ABA", transaction: "VA03" });
    fiori.add({ id: "chrome:2", system: "S4H" });
    fiori.add({ id: "chrome:3", system: "S4H" });
    await registry.discover();
    expect(registry.resolve("fiori")?.id).toBe("chrome:2");
    expect(registry.resolve("WebGUI")?.id).toBe("chrome:1");
    expect(registry.resolve("sapgui")).toBeUndefined();
    registry.active = "chrome:3";
    expect(registry.resolve("fiori")?.id).toBe("chrome:3");
    expect(registry.resolve("2")?.id).toBe("chrome:2");
    expect(registry.resolve("va03")?.id).toBe("chrome:1");
  });
});

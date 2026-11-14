import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { HostError, PsHost } from "../../src/sapgui/host.js";

const launch = { command: process.execPath, args: [fileURLToPath(new URL("./echo-host.mjs", import.meta.url))] };
type Pong = { pid: number; echo: string | null };

describe("sapgui host process", () => {
  test("one process answers many requests, texts in UTF-8", async () => {
    const host = new PsHost(process.env, launch);
    const [a, b] = await Promise.all([host.request<Pong>("ping", { text: "Löschen 削除" }), host.request<Pong>("noise")]);
    expect(a.echo).toBe("Löschen 削除");
    expect(b.pid).toBe(a.pid);
    host.close();
  });

  test("a host error keeps its code", async () => {
    const host = new PsHost(process.env, launch);
    const e = await host.request("fail").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HostError);
    expect((e as HostError).code).toBe("NOT_FOUND");
    expect((e as HostError).message).toBe("no control x");
    host.close();
  });

  test("it is started again after it dies", async () => {
    const host = new PsHost(process.env, launch);
    const first = await host.request<Pong>("ping");
    await expect(host.request("die")).rejects.toThrow("stopped");
    const second = await host.request<Pong>("ping");
    expect(second.pid).not.toBe(first.pid);
    host.close();
  });

  test("a call that never answers times out, and the next one works", async () => {
    const host = new PsHost(process.env, launch);
    await expect(host.request("hang", {}, 300)).rejects.toThrow("did not answer");
    expect((await host.request<Pong>("ping")).echo).toBeNull();
    host.close();
  });
});

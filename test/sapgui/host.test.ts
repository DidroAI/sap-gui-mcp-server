import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { HostError, HostTimeout, MAX_TIMEOUT_MS, parsePolicy, PsHost, READ_TIMEOUT_MS } from "../../src/sapgui/host.js";

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

  test("the timeout says what may be going on, and blames no dialog it did not see", async () => {
    const host = new PsHost(process.env, launch);
    const e = (await host.request("hang", {}, 1200).catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(HostTimeout);
    expect(e.message).toStartWith("SAP GUI did not answer within 1 s (a long-running report or a modal dialog)");
    expect(e.message).not.toContain("script is trying");
    expect(e.message).not.toContain("security dialog");
    host.close();
  });

  test("requests are sent one at a time, and a request's clock starts when it is sent", async () => {
    const host = new PsHost(process.env, launch);
    await host.request("ping"); // the host is up
    // Three requests of 250 ms each, each with a limit of 600 ms: queued behind each other, the third waits 500 ms before it is sent.
    const t0 = Date.now();
    const all = await Promise.all([1, 2, 3].map(() => host.request<{ at: number }>("slow", { ms: 250 }, 600)));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(700);
    // The host received each one only after it had answered the one before.
    expect(all[1]!.at - all[0]!.at).toBeGreaterThanOrEqual(240);
    expect(all[2]!.at - all[1]!.at).toBeGreaterThanOrEqual(240);
    host.close();
  });

  test("a timeout fails its own request only: the ones that wait go to a new host", async () => {
    const host = new PsHost(process.env, launch);
    const first = await host.request<Pong>("ping");
    const stuck = host.request("hang", {}, 300).catch((x: unknown) => x);
    const next = host.request<Pong>("ping", { text: "after" });
    expect(await stuck).toBeInstanceOf(HostTimeout);
    const answer = await next;
    expect(answer.echo).toBe("after");
    expect(answer.pid).not.toBe(first.pid);
    host.close();
  });

  test("what a killed host still writes is ignored", async () => {
    const host = new PsHost(process.env, launch);
    // The first host ignores the kill and answers late, also under the id of the next request.
    const stuck = host.request("linger", { ms: 600 }, 200).catch((x: unknown) => x);
    const next = host.request<{ pid: number; late?: boolean; at?: number }>("slow", { ms: 800 }, 5000);
    expect(await stuck).toBeInstanceOf(HostTimeout);
    const answer = await next;
    expect(answer.late).toBeUndefined();
    expect(answer.at).toBeGreaterThan(0);
    host.close();
  });

  test("no request may take longer than ten minutes, whatever the caller asks", () => {
    expect(READ_TIMEOUT_MS).toBe(60_000);
    expect(MAX_TIMEOUT_MS).toBe(600_000);
  });

  test("closing fails what is waiting", async () => {
    const host = new PsHost(process.env, launch);
    const a = host.request("hang").catch((x: unknown) => (x as Error).message);
    const b = host.request("ping").catch((x: unknown) => (x as Error).message);
    host.close();
    expect(await a).toBe("The SAP GUI host was closed.");
    expect(await b).toBe("The SAP GUI host was closed.");
  });
});

describe("closing the host", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  test("a host stuck in a call is killed after the grace", async () => {
    const host = new PsHost(process.env, launch);
    const { pid } = await host.request<Pong>("ping");
    const stuck = host.request("stuck").catch((x: unknown) => (x as Error).message);
    const t0 = Date.now();
    await host.close(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    expect(await stuck).toBe("The SAP GUI host was closed.");
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
    expect(alive(pid)).toBe(false);
  });
  test("a free host exits by itself, without waiting for the grace", async () => {
    const host = new PsHost(process.env, launch);
    const { pid } = await host.request<Pong>("ping");
    const t0 = Date.now();
    await host.close(5000);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(alive(pid)).toBe(false);
  });
  test("closing a host never started is done at once", async () => {
    await new PsHost(process.env, launch).close();
  });
});

describe("PowerShell policy probe", () => {
  test("reads the language mode and the AppLocker service", () => {
    expect(parsePolicy("sap-ui-automation|FullLanguage|\r\n")).toEqual({ languageMode: "FullLanguage", appLocker: false });
    expect(parsePolicy("noise\nsap-ui-automation|ConstrainedLanguage|Running\n")).toEqual({ languageMode: "ConstrainedLanguage", appLocker: true });
    expect(parsePolicy("sap-ui-automation|FullLanguage|Stopped")).toEqual({ languageMode: "FullLanguage", appLocker: false });
  });
  test("no answer keeps the reason", () => {
    expect(parsePolicy("", "spawn powershell.exe ENOENT")).toEqual({ languageMode: "", appLocker: false, error: "spawn powershell.exe ENOENT" });
    expect(parsePolicy("This program is blocked by group policy.").error).toContain("blocked by group policy");
  });
});

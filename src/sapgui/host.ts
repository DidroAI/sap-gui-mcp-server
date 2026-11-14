/**
 * The PowerShell host process (ps/host.ps1): started on first use, kept
 * warm, restarted when it dies. Windows PowerShell 5.1 ships with Windows,
 * so SAP GUI scripting (COM) is reached with nothing to install.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Transport } from "./facts.js";

/** An error the host reported, with its code ("NO_SAPGUI", "NOT_FOUND", ...) when it gave one. */
export class HostError extends Error {
  override name = "HostError";
  readonly code: string;
  constructor(message: string) {
    const m = /^([A-Z_]+): ([\s\S]*)$/.exec(message);
    super(m?.[2] ?? message);
    this.code = m?.[1] ?? "";
  }
}

interface Waiting {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export const HOST_SCRIPT = fileURLToPath(new URL("./ps/host.ps1", import.meta.url));

export class PsHost implements Transport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private waiting = new Map<number, Waiting>();
  private next = 1;
  private buffer = "";
  private stderr = "";

  /** @param launch another command that speaks the host's protocol (tests). */
  constructor(
    private env: Record<string, string | undefined> = process.env,
    private launch?: { command: string; args: string[] },
  ) {}

  private start(): ChildProcessWithoutNullStreams {
    const root = this.env.SystemRoot ?? this.env.windir;
    const exe = root ? join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
    const { command, args } = this.launch ?? { command: exe, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HOST_SCRIPT] };
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: this.env as NodeJS.ProcessEnv,
    });
    this.buffer = "";
    this.stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.read(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-2000);
    });
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = undefined;
      const detail = this.stderr.trim().split(/\r?\n/).slice(0, 3).join(" ");
      this.failAll(new Error(`The SAP GUI host (PowerShell) stopped: ${why}${detail ? `. ${detail}` : ""}`));
    };
    child.on("error", (e) => gone(e.message));
    child.on("exit", (code) => gone(`exit code ${code}`));
    child.stdin.on("error", () => {});
    return child;
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    for (let i = this.buffer.indexOf("\n"); i >= 0; i = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line.startsWith("{")) continue;
      let msg: { id?: number; ok?: boolean; result?: unknown; error?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const w = msg.id === undefined ? undefined : this.waiting.get(msg.id);
      if (!w || msg.id === undefined) continue;
      this.settle(msg.id, w);
      if (msg.ok) w.resolve(msg.result);
      else w.reject(new HostError(msg.error ?? "the host gave no reason"));
    }
  }

  private settle(id: number, w: Waiting): void {
    clearTimeout(w.timer);
    this.waiting.delete(id);
    if (!this.waiting.size) this.idle(true);
  }

  private failAll(e: Error): void {
    for (const [id, w] of [...this.waiting]) {
      this.settle(id, w);
      w.reject(e);
    }
  }

  /** An idle host does not keep the server's process alive. */
  private idle(yes: boolean): void {
    const c = this.child;
    if (!c) return;
    for (const h of [c, c.stdin, c.stdout, c.stderr] as { ref?: () => void; unref?: () => void }[]) (yes ? h.unref : h.ref)?.call(h);
  }

  request<T>(op: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.child ??= this.start();
      } catch (e) {
        reject(new Error(`Could not start Windows PowerShell for SAP GUI: ${(e as Error).message}`));
        return;
      }
      const id = this.next++;
      const timer = setTimeout(() => {
        // The host answers one request at a time: a stuck call blocks the rest, so start afresh.
        this.child = undefined;
        child.kill();
        const e = new Error(
          `SAP GUI did not answer within ${Math.round(timeoutMs / 1000)} s. A dialog may be waiting in SAP GUI (a Windows file or security dialog, or "A script is trying to access SAP GUI"): look at the screen or call sap_screenshot.`,
        );
        this.failAll(e);
      }, timeoutMs);
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.idle(false);
      child.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`);
    });
  }

  close(): void {
    const c = this.child;
    this.child = undefined;
    c?.stdin.end();
    this.failAll(new Error("The SAP GUI host was closed."));
  }
}

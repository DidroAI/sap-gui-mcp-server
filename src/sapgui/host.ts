/**
 * The PowerShell host process (ps/host.ps1): started on first use, kept
 * warm, restarted when it dies. Windows PowerShell 5.1 ships with Windows,
 * so SAP GUI scripting (COM) is reached with nothing to install.
 *
 * The host answers one request at a time, so requests wait in a queue here
 * and one is sent at a time. A request's time limit starts when it is sent,
 * not when it is queued: a slow step does not use up the time of the next.
 */
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
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

/** SAP GUI did not answer in time. */
export class HostTimeout extends Error {
  override name = "HostTimeout";
}

/** Time limit of a request when the caller gives none: reads. */
export const READ_TIMEOUT_MS = 60_000;
/** The longest any request may take: a long-running report started with F8. */
export const MAX_TIMEOUT_MS = 600_000;

interface Job {
  id: number;
  line: string;
  timeoutMs: number;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export const HOST_SCRIPT = fileURLToPath(new URL("./ps/host.ps1", import.meta.url));

/** Windows PowerShell 5.1, by its full path when Windows says where it is. */
export function powershellExe(env: Record<string, string | undefined>): string {
  const root = env.SystemRoot ?? env.windir;
  return root ? join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
}

export class PsHost implements Transport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private queue: Job[] = [];
  /** The request the host is working on, and its timer. */
  private current: (Job & { timer: NodeJS.Timeout }) | undefined;
  private next = 1;
  private stderr = "";

  /** @param launch another command that speaks the host's protocol (tests). */
  constructor(
    private env: Record<string, string | undefined> = process.env,
    private launch?: { command: string; args: string[] },
  ) {}

  private start(): ChildProcessWithoutNullStreams {
    const { command, args } = this.launch ?? { command: powershellExe(this.env), args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HOST_SCRIPT] };
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: this.env as NodeJS.ProcessEnv,
    });
    this.stderr = "";
    // Each child has its own buffer, and a child that was replaced or killed is not listened to any more.
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child) return;
      buffer += chunk;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        this.answer(line);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (this.child !== child) return;
      this.stderr = (this.stderr + chunk).slice(-2000);
    });
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = undefined;
      const detail = this.stderr.trim().split(/\r?\n/).slice(0, 3).join(" ");
      // The request in flight is lost with the process; the ones still waiting go to a new process.
      this.finish((job) => job.reject(new Error(`The SAP GUI host (PowerShell) stopped: ${why}${detail ? `. ${detail}` : ""}`)));
    };
    child.on("error", (e) => gone(e.message));
    child.on("exit", (code) => gone(`exit code ${code}`));
    child.stdin.on("error", () => {});
    return child;
  }

  private answer(line: string): void {
    if (!line.startsWith("{")) return;
    let msg: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // Only the request in flight can be answered: anything else is late or stray.
    if (!this.current || msg.id !== this.current.id) return;
    this.finish((job) => (msg.ok ? job.resolve(msg.result) : job.reject(new HostError(msg.error ?? "the host gave no reason"))));
  }

  /** Ends the request in flight, then sends the next one. */
  private finish(settle: (job: Job) => void): void {
    const job = this.current;
    this.current = undefined;
    if (job) {
      clearTimeout(job.timer);
      settle(job);
    }
    this.pump();
  }

  /** Sends the next waiting request, if the host is free. */
  private pump(): void {
    if (this.current) return;
    const job = this.queue.shift();
    if (!job) {
      this.idle(true);
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.child ??= this.start();
    } catch (e) {
      job.reject(new Error(`Could not start Windows PowerShell for SAP GUI: ${(e as Error).message}`));
      this.pump();
      return;
    }
    // The clock starts now, when the request goes to the host.
    const timer = setTimeout(() => {
      if (this.current?.id !== job.id) return;
      // A stuck call blocks the host: stop it, and let the next request start a new one.
      this.child = undefined;
      child.kill();
      this.finish((j) =>
        j.reject(new HostTimeout(`SAP GUI did not answer within ${Math.round(job.timeoutMs / 1000)} s (a long-running report or a modal dialog). Look at the screen or call sap_screenshot.`)),
      );
    }, job.timeoutMs);
    this.current = { ...job, timer };
    this.idle(false);
    child.stdin.write(job.line);
  }

  /** An idle host does not keep the server's process alive. */
  private idle(yes: boolean): void {
    const c = this.child;
    if (!c) return;
    for (const h of [c, c.stdin, c.stdout, c.stderr] as { ref?: () => void; unref?: () => void }[]) (yes ? h.unref : h.ref)?.call(h);
  }

  request<T>(op: string, params: Record<string, unknown> = {}, timeoutMs = READ_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.next++;
      const limit = Math.min(Math.max(1, timeoutMs), MAX_TIMEOUT_MS);
      this.queue.push({ id, line: `${JSON.stringify({ id, op, ...params })}\n`, timeoutMs: limit, resolve: resolve as (v: unknown) => void, reject });
      this.pump();
    });
  }

  /**
   * Ends stdin, so a free host exits by itself. A host stuck in a COM call
   * never reads it: it is killed after `graceMs`. Resolves when it is gone.
   */
  close(graceMs = 1000): Promise<void> {
    const c = this.child;
    this.child = undefined;
    const closed = new Error("The SAP GUI host was closed.");
    const waiting = this.queue.splice(0);
    const job = this.current;
    this.current = undefined;
    if (job) {
      clearTimeout(job.timer);
      job.reject(closed);
    }
    for (const w of waiting) w.reject(closed);
    if (!c || c.exitCode !== null || c.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        c.kill();
        resolve();
      }, graceMs);
      c.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      c.stdin.end();
    });
  }
}

/** What Windows lets PowerShell do on this machine, read without the host script (which a policy may block). */
export interface PowershellPolicy {
  /** "FullLanguage", "ConstrainedLanguage", "RestrictedLanguage", "NoLanguage"; "" when PowerShell did not answer. */
  languageMode: string;
  /** The AppLocker service (AppIDSvc) is running. */
  appLocker: boolean;
  /** Why PowerShell could not be asked, when it could not. */
  error?: string;
}

const POLICY_COMMAND = "$m = $ExecutionContext.SessionState.LanguageMode; $s = Get-Service -Name AppIDSvc -ErrorAction SilentlyContinue; \"sap-ui-automation|$m|$($s.Status)\"";

/** Reads the policy line PowerShell printed. */
export function parsePolicy(stdout: string, error?: string): PowershellPolicy {
  const m = /sap-ui-automation\|([A-Za-z]*)\|([A-Za-z]*)/.exec(stdout);
  if (!m) return { languageMode: "", appLocker: false, error: error || stdout.trim().split(/\r?\n/)[0] || "PowerShell gave no answer" };
  return { languageMode: m[1] ?? "", appLocker: /^running$/i.test(m[2] ?? "") };
}

/**
 * Asks PowerShell for its language mode with a one-line command: that works
 * in Constrained Language Mode, where the host script does not.
 */
export function powershellPolicy(env: Record<string, string | undefined> = process.env): Promise<PowershellPolicy> {
  return new Promise((resolve) => {
    execFile(powershellExe(env), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POLICY_COMMAND], { windowsHide: true, timeout: 20_000, env: env as NodeJS.ProcessEnv }, (err, stdout, stderr) =>
      resolve(parsePolicy(String(stdout ?? ""), err ? `${err.message.split(/\r?\n/)[0]} ${String(stderr ?? "").trim().split(/\r?\n/)[0] ?? ""}`.trim() : undefined)),
    );
  });
}

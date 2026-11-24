/**
 * `doctor`: what the server can reach on this machine, as a short report a
 * person can act on. One block per area (Chrome serves Web GUI and Fiori, so
 * its checks appear once), a mark per check, and the one thing to do when a
 * check fails.
 */
import type { DoctorCheck, Surface } from "../core/types.js";

const AREAS: Record<string, string> = {
  webgui: "Chrome: Web GUI and Fiori",
  fiori: "Chrome: Web GUI and Fiori",
  sapgui: "SAP GUI for Windows",
};

/** Wraps text to the terminal width, indenting every line. */
function wrap(text: string, indent: string, width: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && indent.length + line.length + 1 + w.length > width) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l).join("\n");
}

export interface DoctorReport {
  text: string;
  ok: boolean;
}

export async function doctorReport(surfaces: Surface[], version: string, platform: NodeJS.Platform = process.platform, width = Math.min(process.stdout.columns || 88, 100)): Promise<DoctorReport> {
  const areas = new Map<string, DoctorCheck[]>();
  const seen = new Set<string>();
  for (const s of surfaces) {
    const area = AREAS[s.name] ?? s.name;
    const list = areas.get(area) ?? [];
    areas.set(area, list);
    let checks: DoctorCheck[];
    try {
      checks = await s.doctor();
    } catch (e) {
      checks = [{ ok: false, check: s.name, detail: (e as Error).message }];
    }
    for (const c of checks) {
      const key = `${area}|${c.check}|${c.detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(c);
    }
  }
  const out: string[] = [`sap-ui-automation ${version}`, ""];
  let ok = true;
  for (const [area, checks] of areas) {
    out.push(area);
    for (const c of checks) {
      ok &&= c.ok;
      out.push(`  ${wrap(`${c.ok ? "✓" : "✗"} ${c.check}: ${c.detail}`, "    ", width).slice(4)}`);
      if (!c.ok && c.fix) out.push(wrap(`→ ${c.fix}`, "    ", width));
    }
    out.push("");
  }
  if (platform !== "win32" && !areas.has(AREAS.sapgui ?? "")) out.push("SAP GUI for Windows", "  – not checked: it runs only on Windows. On this machine, use Web GUI or Fiori in Chrome.", "");
  out.push(ok ? "Ready. Ask your agent to look at your SAP screen; for Web GUI and Fiori, log on in the Chrome window the server opens. (Agent does not list the sap-ui-automation tools? Run npx -y sap-ui-automation setup, then restart the agent.)" : "Not ready yet: fix the ✗ above, then run doctor again.");
  return { text: out.join("\n"), ok };
}

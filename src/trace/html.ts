/**
 * A trace (or any recording) as one HTML page: header, a timeline of step
 * durations, then each step with its action, SDK line, screens, status bar,
 * checks, the screen the agent saw (and what changed from the step before),
 * and its screenshot.
 *
 * The page stands alone: CSS and JS inline, screenshots as data: URIs, no
 * network. Every text from the file (screen text comes from SAP) is escaped;
 * nothing from it reaches the page's script.
 */
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { diffViews, sameScreen } from "../core/diff.js";
import type { SapTest, Step } from "../record/format.js";
import type { ReplayResult, StepResult } from "../record/replay.js";
import { formatMs, screenLabel, stepCode, traceSummary } from "./summary.js";

export interface TraceHtmlOptions {
  /** The directory the test file is in: screenshot paths are relative to it. */
  baseDir: string;
  /** A run of this test: its step times are shown next to the recorded ones. */
  replay?: ReplayResult;
  /** The page title; default the test's name. */
  title?: string;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Text for HTML content and attribute values. */
export const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c] ?? c);

const IMAGE: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** A screenshot as a data: URI; only an image file inside baseDir (a trace cannot pull in other files). */
async function shotUri(baseDir: string, shot: string): Promise<string | undefined> {
  const root = resolve(baseDir);
  const file = resolve(root, shot);
  const type = IMAGE[extname(file).toLowerCase()];
  if (!type || !file.startsWith(root + sep)) return undefined;
  const data = await readFile(file).catch(() => undefined);
  return data ? `data:${type};base64,${data.toString("base64")}` : undefined;
}

/** Replay is slower than recorded: more than twice the time, and more than a second more. */
export const slower = (recorded: number, replayed: number): boolean => replayed > 2 * recorded && replayed - recorded > 1000;

const STATUS: Record<string, string> = { S: "ok", I: "info", W: "warn", E: "err", A: "err" };

function ref(r: Step["on"] | Step["after"], label: string): string {
  const where = screenLabel(r);
  if (!where && !r?.title) return "";
  return `<div class="ref"><span class="k">${label}</span> <code>${esc(where ?? "")}</code> ${r?.title ? esc(r.title) : ""}</div>`;
}

/** A diff's lines, coloured by their mark. */
const diffHtml = (text: string): string =>
  text
    .split("\n")
    .map((l, i) => `<span class="${i === 0 ? "dh" : ({ "+": "da", "-": "dd", "~": "dc" } as Record<string, string>)[l[0] ?? ""] ?? ""}">${esc(l)}</span>`)
    .join("\n");

function stepHtml(s: Step, n: number, prevScreen: string | undefined, shot: string | undefined, run: StepResult | undefined, maxMs: number): string {
  const code = stepCode(s);
  const risk = s.risk ? `<span class="badge risk-${esc(s.risk)}">${esc(s.risk)}</span>` : "";
  const target = s.target ? `<div class="target"><span class="k">on</span> ${esc(s.target.label ?? "")} <code>${esc(s.target.id)}</code>${s.target.type ? ` <span class="dim">${esc(s.target.type)}</span>` : ""}</div>` : "";
  let time = typeof s.ms === "number" ? formatMs(s.ms) : "";
  if (run) {
    const slow = typeof s.ms === "number" && slower(s.ms, run.ms);
    time += `${time ? " recorded, " : ""}<span class="${slow ? "slow" : ""}">${esc(formatMs(run.ms))} replayed${slow ? " (slower)" : ""}</span>`;
  }
  const outcome = run ? `<span class="badge out-${esc(run.outcome)}">${esc(run.outcome)}</span>` : "";
  const st = s.after?.status;
  const status = st ? `<div class="status st-${STATUS[st.type ?? ""] ?? "none"}"><b>${esc(st.type ?? "")}</b> ${esc(st.text)}</div>` : "";
  const list = (cls: string, items: string[]) => (items.length ? `<ul class="${cls}">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
  const checks = list("checks", [
    ...(s.expect ?? []).map((c) => `expect ${c.check}${c.id ? ` ${c.label ?? c.id}` : ""} ${c.op} "${c.value}"`),
    ...(s.capture ?? []).map((c) => `capture \${${c.var}} from ${c.from}${c.id ? ` ${c.label ?? c.id}` : ""}${c.pattern ? ` /${c.pattern}/` : ""}`),
  ]);
  const runNotes = run ? list("fails", run.failures) + list("warns", run.warnings) : "";
  let screen = "";
  if (s.screen) {
    const diff = prevScreen === undefined ? undefined : sameScreen(prevScreen, s.screen) ? diffHtml(diffViews(prevScreen, s.screen).text.replace(/; sap_look shows (all of )?it/, "")) : "new screen";
    screen = `<details class="screen"><summary>Screen the agent saw</summary>${diff ? `<button type="button" class="tog">diff vs previous step</button><pre class="diff" hidden>${diff}</pre>` : ""}<pre class="full">${esc(s.screen)}</pre></details>`;
  }
  const img = shot ? `<details class="shot" open><summary>Screenshot</summary><img alt="screenshot after step ${n}" src="${shot}"></details>` : "";
  const width = maxMs > 0 && typeof s.ms === "number" ? Math.max(1, (100 * s.ms) / maxMs) : 0;
  return `<section class="step${s.risk === "commit" ? " commit" : ""}${run?.outcome === "fail" ? " failed" : ""}" id="step-${n}">
<h2><a href="#step-${n}">${n}</a> ${code ? `<code>${esc(code)}</code>` : '<span class="dim">check only</span>'} ${risk}${outcome}<span class="time">${time}</span></h2>
${width ? `<div class="mini"><i style="width:${width.toFixed(1)}%"></i></div>\n` : ""}${s.note ? `<p class="note">${esc(s.note)}</p>` : ""}${s.action ? `<pre class="json">${esc(JSON.stringify(s.action))}</pre>` : ""}${target}${ref(s.on, "on")}${ref(s.after, "after")}${status}${checks}${runNotes}${screen}${img}
</section>`;
}

const CSS = `:root{--bg:#fff;--fg:#1d1f23;--dim:#6a6f78;--line:#e3e5e8;--card:#f7f8fa;--acc:#2b6cb0;--ok:#1f7a3a;--warn:#a46500;--err:#c0262d;--info:#2b6cb0;--commit:#fde8e8;--add:#e6f6ea;--del:#fdecec;--chg:#fff6dc}
@media (prefers-color-scheme:dark){:root{--bg:#15171a;--fg:#e4e6ea;--dim:#959ba5;--line:#2b2f35;--card:#1d2024;--acc:#78a9e6;--ok:#5cc27c;--warn:#e0a63a;--err:#f06b6f;--info:#78a9e6;--commit:#3a1f22;--add:#183223;--del:#3a1f22;--chg:#3a3218}}
*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;max-width:1100px;margin-inline:auto}
code,pre{font:12px/1.4 ui-monospace,Menlo,Consolas,monospace}pre{white-space:pre-wrap;word-break:break-word;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px;margin:6px 0;overflow:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:0;display:flex;gap:8px;align-items:center;flex-wrap:wrap}h2 a{color:var(--acc);text-decoration:none;min-width:2ch}
.meta{color:var(--dim);display:flex;flex-wrap:wrap;gap:4px 16px;margin-bottom:12px}.dim,.k{color:var(--dim)}.k{font-size:12px}
.tl{display:flex;height:22px;border:1px solid var(--line);border-radius:6px;overflow:hidden;margin:8px 0 16px}.tl a{display:block;min-width:3px;background:var(--acc);opacity:.55;border-right:1px solid var(--bg)}.tl a:nth-child(odd){opacity:.8}.tl a.c{background:var(--err)}.tl a.f{background:var(--err);opacity:1}.tl a:hover{opacity:1}
.step{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:10px 0}.step.commit{border-left:4px solid var(--err)}.step.failed{outline:2px solid var(--err)}.step.cur{box-shadow:0 0 0 2px var(--acc)}
.time{margin-left:auto;color:var(--dim);font-size:12px}.slow{color:var(--err);font-weight:600}.mini{height:3px;background:var(--line);margin:6px 0}.mini i{display:block;height:3px;background:var(--acc)}
.badge{font-size:11px;padding:1px 6px;border-radius:9px;border:1px solid var(--line);color:var(--dim)}.risk-commit{background:var(--commit);color:var(--err);border-color:var(--err);font-weight:600}.out-pass{color:var(--ok)}.out-fail{color:var(--err);border-color:var(--err)}
.status{padding:4px 8px;border-radius:4px;margin:6px 0;border-left:4px solid var(--dim);background:var(--card)}.st-ok{border-color:var(--ok)}.st-warn{border-color:var(--warn)}.st-err{border-color:var(--err);color:var(--err)}.st-info{border-color:var(--info)}
.ref,.target{margin:2px 0}.note{margin:4px 0;font-style:italic}ul{margin:4px 0;padding-left:20px}.fails{color:var(--err)}.warns{color:var(--warn)}
summary{cursor:pointer;color:var(--dim);margin-top:6px}.tog{font:inherit;font-size:12px;margin:6px 0 0;cursor:pointer;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:4px}
.da{background:var(--add)}.dd{background:var(--del)}.dc{background:var(--chg)}.dh{color:var(--dim)}img{max-width:100%;border:1px solid var(--line);border-radius:4px;margin-top:6px}
.res{font-weight:600}.res.pass{color:var(--ok)}.res.fail{color:var(--err)}`;

const JS = `document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest(".tog");if(!b)return;var d=b.nextElementSibling,f=d.nextElementSibling,on=d.hidden;d.hidden=!on;f.hidden=on;b.textContent=on?"full screen":"diff vs previous step"});
var S=[].slice.call(document.querySelectorAll(".step")),i=-1;document.addEventListener("keydown",function(e){if(e.target.closest&&e.target.closest("input,textarea")||e.ctrlKey||e.metaKey||e.altKey)return;var k=e.key;if(k!=="j"&&k!=="k")return;if(i>=0)S[i].classList.remove("cur");i=Math.max(0,Math.min(S.length-1,i+(k==="j"?1:-1)));S[i].classList.add("cur");S[i].scrollIntoView({block:"start"})});`;

/** The page for one test, with its screenshots read from `baseDir`. */
export async function renderTraceHtml(test: SapTest, opts: TraceHtmlOptions): Promise<string> {
  const sum = traceSummary(test);
  const runs = new Map((opts.replay?.steps ?? []).map((r) => [r.n, r]));
  const maxMs = Math.max(0, ...test.steps.map((s) => s.ms ?? 0));
  const shots = await Promise.all(test.steps.map((s) => (s.shot ? shotUri(opts.baseDir, s.shot) : undefined)));
  let prev: string | undefined;
  const steps = test.steps.map((s, i) => {
    const html = stepHtml(s, i + 1, prev, shots[i], runs.get(i + 1), maxMs);
    if (s.screen) prev = s.screen;
    return html;
  });
  // Steps without a time still get a sliver, so every step can be pointed at.
  const timeline = test.steps
    .map((s, i) => {
      const cls = runs.get(i + 1)?.outcome === "fail" ? "f" : s.risk === "commit" ? "c" : "";
      const tip = `${i + 1}. ${stepCode(s) ?? "check"}${typeof s.ms === "number" ? ` (${formatMs(s.ms)})` : ""}`;
      return `<a href="#step-${i + 1}" class="${cls}" style="flex:${Math.max(s.ms ?? 0, 1)} 0 0" title="${esc(tip)}"></a>`;
    })
    .join("");
  const r = test.recorded;
  const where = [r.system, r.client ? `client ${r.client}` : ""].filter(Boolean).join(" ");
  const rp = opts.replay;
  const meta = [
    where && `<span>${esc(where)}</span>`,
    `<span>${esc(r.surface)}${r.method ? ` (${esc(r.method)})` : ""}</span>`,
    `<span>recorded ${esc(r.at)}${r.by ? ` by ${esc(r.by)}` : ""}</span>`,
    `<span>${sum.steps} step${sum.steps === 1 ? "" : "s"}</span>`,
    sum.timed ? `<span>${esc(formatMs(sum.totalMs))} in steps${sum.wallMs !== undefined ? `, ${esc(formatMs(sum.wallMs))} overall` : ""}</span>` : "",
    rp ? `<span class="res ${rp.passed ? "pass" : "fail"}">replay ${rp.passed ? "passed" : "failed"} in ${esc(formatMs(rp.ms))}${rp.aborted ? `: ${esc(rp.aborted)}` : ""}</span>` : "",
  ].filter(Boolean);
  const title = opts.title ?? test.name;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<h1>${esc(title)}</h1>${test.description ? `<p>${esc(test.description)}</p>` : ""}
<div class="meta">${meta.join("")}</div>
${test.steps.length ? `<nav class="tl" aria-label="step durations">${timeline}</nav>` : "<p class=dim>No steps.</p>"}
${steps.join("\n")}
<p class="dim">j / k: next / previous step</p>
<script>${JS}</script></body></html>
`;
}

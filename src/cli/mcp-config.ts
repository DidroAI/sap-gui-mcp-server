/**
 * The file writers `setup` uses for MCP configs: JSON (with comments where the agent reads them)
 * and Goose's YAML. Each one adds this server's entry and leaves the rest of the file as it was,
 * comments and layout included; an entry already there is never replaced.
 */
import { findNodeAtLocation, type Node, type ParseError, parse, parseTree } from "jsonc-parser";
import type { EntryShape } from "./agents.js";

export const NAME = "sap-ui-automation";
/** Names this server had before the rename (2026-11-24): an entry left under one gives the agent the tools twice. */
export const OLD_NAMES = ["sap-gui-mcp-server", "sap-gui"] as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** This server's entry, in the shape the agent reads. */
export function jsonEntry(shape: EntryShape, command: string[], env: Record<string, string>): Record<string, unknown> {
  const vars = Object.keys(env).length ? env : undefined;
  const cmd = command[0] ?? "";
  const args = command.slice(1);
  if (shape === "opencode") return { type: "local", command, ...(vars ? { environment: vars } : {}) };
  const base = { command: cmd, args, ...(vars ? { env: vars } : {}) };
  if (shape === "stdio") return { type: "stdio", ...base };
  if (shape === "copilot") return { type: "local", ...base, tools: ["*"] };
  return base;
}

export type Edit =
  | { kind: "present"; text: string; old: string[]; missingEnv: [string, string][] }
  | { kind: "add"; text: string; old: string[] }
  | { kind: "error"; reason: string };

/** The indentation unit and line ending a JSON file uses, so that the new entry matches them. */
function layout(text: string): { unit: string; eol: string } {
  const m = /\n([ \t]+)["}]/.exec(text);
  const lead = m?.[1] ?? "  ";
  return { unit: lead.startsWith("\t") ? "\t" : lead.length > 4 ? "  " : lead, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

/** The whitespace a line starts with. */
function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start))?.[0] ?? "";
}

/**
 * Inserts `"key": value` as the last member of the object `obj`, touching nothing else: the other
 * members, comments and layout stay as they are (jsonc-parser's own `modify` re-lays out the member
 * before the new one).
 */
function insertMember(text: string, obj: Node, key: string, value: unknown, unit: string, eol: string): string {
  const members = obj.children ?? [];
  const last = members.at(-1);
  if (last) {
    const onOwnLine = !text.slice(text.lastIndexOf("\n", last.offset - 1) + 1, last.offset).trim();
    const indent = onOwnLine ? lineIndent(text, last.offset) : lineIndent(text, obj.offset) + unit;
    const body = JSON.stringify(value, null, unit).split("\n").join(eol + indent);
    const at = last.offset + last.length;
    return `${text.slice(0, at)},${eol}${indent}${JSON.stringify(key)}: ${body}${text.slice(at)}`;
  }
  // An empty object, perhaps with comments inside: the member right after its brace.
  const outer = lineIndent(text, obj.offset);
  const indent = outer + unit;
  const body = JSON.stringify(value, null, unit).split("\n").join(eol + indent);
  const open = obj.offset + 1;
  const close = obj.offset + obj.length - 1;
  const inside = text.slice(open, close);
  if (!inside.trim()) return `${text.slice(0, open)}${eol}${indent}${JSON.stringify(key)}: ${body}${eol}${outer}${text.slice(close)}`;
  return `${text.slice(0, open)}${eol}${indent}${JSON.stringify(key)}: ${body}${text.slice(open)}`;
}

/**
 * Adds `entry` under `key` (a path of object keys) of a JSON config, unless it is there. `comments`:
 * the agent reads comments and trailing commas, so they may be in the file and are kept; otherwise a
 * file with them is not valid and is left alone. `envKey` is where the entry keeps its variables.
 */
export function addToJson(text: string, key: string[], entry: Record<string, unknown>, comments: boolean, opts: { envKey?: string; opencode?: boolean } = {}): Edit {
  const source = text.trim() ? text : "{}";
  const errors: ParseError[] = [];
  const config: unknown = parse(source, errors, { allowTrailingComma: comments, disallowComments: !comments });
  if (errors.length) return { kind: "error", reason: `is not valid JSON${comments ? " (with comments)" : ""}` };
  const where = key.map((k) => `"${k}"`).join(" → ");
  if (!isPlainObject(config)) return { kind: "error", reason: "does not hold a JSON object" };
  let path = key;
  let servers: unknown = config;
  for (const k of key) {
    servers = isPlainObject(servers) ? (servers[k] ?? {}) : undefined;
    if (!isPlainObject(servers)) return { kind: "error", reason: `has a ${where} that is not an object` };
  }
  let found = (servers as Record<string, unknown>)[NAME];
  if (opts.opencode) {
    // OpenCode's older form keeps servers right under "mcp": a file that uses it keeps it.
    const mcp = (config.mcp ?? {}) as Record<string, unknown>;
    found ??= mcp[NAME];
    const legacy = Object.keys(mcp).some((k) => k !== "servers" && k !== "timeout");
    if (legacy && !("servers" in mcp)) {
      path = ["mcp"];
      servers = mcp;
    }
  }
  const old = OLD_NAMES.filter((n) => n in (servers as Record<string, unknown>));
  if (found) {
    const envKey = opts.envKey ?? "env";
    const want = (entry[envKey] ?? {}) as Record<string, string>;
    const have = isPlainObject(found) && isPlainObject(found[envKey]) ? found[envKey] : {};
    return { kind: "present", text, old, missingEnv: Object.entries(want).filter(([k, v]) => have[k] !== v) };
  }
  // A file on one line has no layout to keep: written out again, two spaces per level.
  if (!source.trim().includes("\n") && !/\/[/*]/.test(source.replace(/"(?:[^"\\]|\\.)*"/g, ""))) {
    let at: Record<string, unknown> = config;
    for (const k of path) at = isPlainObject(at[k]) ? (at[k] as Record<string, unknown>) : (at[k] = {});
    at[NAME] = entry;
    return { kind: "add", text: `${JSON.stringify(config, null, 2)}\n`, old };
  }
  // The deepest object of the path that exists gets the rest of the path, with the entry inside.
  const tree = parseTree(source, [], { allowTrailingComma: comments, disallowComments: !comments }) as Node;
  const full = [...path, NAME];
  let depth = path.length;
  let node = findNodeAtLocation(tree, path);
  while (!node && depth > 0) node = --depth === 0 ? tree : findNodeAtLocation(tree, path.slice(0, depth));
  if (!node) node = tree;
  const value = full.slice(depth + 1).reduceRight<unknown>((v, k) => ({ [k]: v }), entry);
  const { unit, eol } = layout(source);
  let out = insertMember(source, node, full[depth] as string, value, unit, eol);
  if (!out.endsWith("\n")) out += eol;
  return { kind: "add", text: out, old };
}

// ---------------------------------------------------------------- Goose: config.yaml

const yamlKey = (name: string) => new RegExp(`^(?:${name}|"${name}"|'${name}')\\s*:`);
const indentOf = (line: string) => /^ */.exec(line)?.[0].length ?? 0;
const blank = (line: string) => !line.trim() || line.trim().startsWith("#");

/** Goose's extension entry (https://goose-docs.ai/docs/guides/config-files), at `indent` spaces. */
export function gooseEntry(command: string[], env: Record<string, string>, indent: number, step: number): string[] {
  const q = JSON.stringify; // a JSON string is a valid YAML double-quoted scalar
  const sub = " ".repeat(indent + step);
  return [
    `${" ".repeat(indent)}${NAME}:`,
    `${sub}name: ${NAME}`,
    `${sub}type: stdio`,
    `${sub}enabled: true`,
    `${sub}cmd: ${q(command[0] ?? "")}`,
    `${sub}args: [${command.slice(1).map((a) => q(a)).join(", ")}]`,
    `${sub}envs: {${Object.entries(env).map(([k, v]) => ` ${k}: ${q(v)} `).join(",")}}`,
    `${sub}env_keys: []`,
    `${sub}timeout: 300`,
  ];
}

/**
 * Adds this server to the top-level `extensions:` mapping of Goose's config.yaml, keeping every other
 * line as it is. A file whose `extensions` is not a block mapping, or that names this server in some
 * other place, is not guessed at.
 */
export function addToGoose(text: string, command: string[], env: Record<string, string>): Edit {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text ? text.split(/\r?\n/) : [];
  const start = lines.findIndex((l) => /^extensions\s*:/.test(l));
  const old = (block: string[], indent: number) => OLD_NAMES.filter((n) => block.some((l) => indentOf(l) === indent && yamlKey(n).test(l.trim())));
  if (start < 0) {
    if (text.includes(NAME)) return { kind: "error", reason: `names "${NAME}" outside an extensions: mapping` };
    const head = text && !text.endsWith("\n") ? `${text}${eol}` : text;
    return { kind: "add", text: `${head}extensions:${eol}${gooseEntry(command, env, 2, 2).join(eol)}${eol}`, old: [] };
  }
  const rest = (lines[start] ?? "").replace(/^extensions\s*:/, "").trim();
  if (rest && !rest.startsWith("#")) return { kind: "error", reason: "has an extensions: value that is not a block mapping" };
  let end = start + 1;
  while (end < lines.length && (blank(lines[end] ?? "") || indentOf(lines[end] ?? "") > 0)) end++;
  const block = lines.slice(start + 1, end);
  const first = block.find((l) => !blank(l));
  const indent = first ? indentOf(first) : 2;
  const ours = block.findIndex((l) => indentOf(l) === indent && yamlKey(NAME).test(l.trim()));
  if (ours >= 0) {
    const after = block.slice(ours + 1);
    const stop = after.findIndex((l) => !blank(l) && indentOf(l) <= indent);
    const body = stop < 0 ? after : after.slice(0, stop);
    const missingEnv = Object.entries(env).filter(([k, v]) => !body.some((l) => l.includes(k) && l.includes(v)));
    return { kind: "present", text, old: old(block, indent), missingEnv };
  }
  if (text.includes(NAME)) return { kind: "error", reason: `names "${NAME}" in a form setup does not read` };
  const step = (() => {
    const deeper = block.find((l) => !blank(l) && indentOf(l) > indent);
    return deeper ? indentOf(deeper) - indent : indent;
  })();
  const out = [...lines.slice(0, start + 1), ...gooseEntry(command, env, indent, step), ...lines.slice(start + 1)];
  let joined = out.join(eol);
  if (!joined.endsWith(eol)) joined += eol;
  return { kind: "add", text: joined, old: old(block, indent) };
}

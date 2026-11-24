// Builds the Claude Desktop extension: sap-gui-mcp-server-<version>.mcpb at the repository root.
//
//   bun run build && bun run build:mcpb
//
// Stages dist/, package.json, LICENSE, README.md and mcpb/manifest.json (its version
// set from package.json) in a temporary folder, installs the production dependencies
// there, then validates and packs it with the MCPB CLI (pinned below).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

if (!existsSync(join(root, "dist", "cli.js"))) {
  console.error("dist/cli.js is missing: run `bun run build` first.");
  process.exit(1);
}

const win = process.platform === "win32";
const run = (cmd, args, cwd) => execFileSync(win ? `${cmd}.cmd` : cmd, args, { cwd, stdio: "inherit", shell: win });

const stage = mkdtempSync(join(tmpdir(), "sap-gui-mcpb-"));
const out = join(root, `${pkg.name}-${pkg.version}.mcpb`);
try {
  // The compiled server, without source maps.
  cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true, filter: (src) => !src.endsWith(".map") });
  for (const f of ["LICENSE", "README.md"]) cpSync(join(root, f), join(stage, f));

  // package.json without scripts or dev dependencies: npm installs only what the server needs.
  const { scripts: _scripts, devDependencies: _dev, ...runtime } = pkg;
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(runtime, null, 2)}\n`);

  const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));
  manifest.version = pkg.version;
  writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], stage);

  run("npx", ["-y", MCPB_CLI, "validate", join(stage, "manifest.json")], stage);
  rmSync(out, { force: true });
  run("npx", ["-y", MCPB_CLI, "pack", stage, out], stage);
  console.log(`\n${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

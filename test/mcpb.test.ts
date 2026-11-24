import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allowedOrigins } from "../src/browser/classify.js";
import { policyFromEnv } from "../src/core/guard.js";
import { recorderOptionsFromEnv } from "../src/record/recorder.js";
import { surfacesFromEnv } from "../src/surfaces.js";
import { downloadDir } from "../src/webgui/files.js";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** The env Claude Desktop starts the server with: each ${user_config.X} replaced by the value, or the default. */
function envFor(values: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(manifest.server.mcp_config.env as Record<string, string>)) {
    env[k] = v.replace(/\$\{user_config\.([A-Z_]+)\}/g, (_, key: string) => values[key] ?? manifest.user_config[key].default);
  }
  return env;
}

describe("Claude Desktop extension manifest", () => {
  test("every user_config option is mapped into env under its own name, with a default", () => {
    for (const [key, option] of Object.entries(manifest.user_config as Record<string, { default?: unknown; required?: boolean }>)) {
      expect(manifest.server.mcp_config.env[key]).toBe(`\${user_config.${key}}`);
      // An option without a default would reach the server as the literal "${user_config.X}".
      expect(option.default).toBeDefined();
      expect(option.required).toBe(false);
    }
  });

  test("its name and version follow package.json, and it runs dist/cli.js", () => {
    expect(manifest.name).toBe(pkg.name);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.server.entry_point).toBe("dist/cli.js");
    expect(manifest.server.mcp_config.args).toEqual(["${__dirname}/dist/cli.js"]);
  });

  test("settings left blank mean the same as unset", () => {
    const env = envFor();
    expect(env.SAP_WRITE).toBe("off");
    expect(policyFromEnv(env)).toEqual(policyFromEnv({}));
    expect(surfacesFromEnv(env).map((s) => s.name)).toEqual(surfacesFromEnv({}).map((s) => s.name));
    expect(allowedOrigins(env)).toBeUndefined();
    expect(recorderOptionsFromEnv(env, "t", "/w").dir).toBe(join("/w", "sap-tests"));
    expect(downloadDir(env, "/w")).toBe(downloadDir({}, "/w"));
  });

  test("an empty SAP_WRITE is off, not an error", () => {
    expect(policyFromEnv({ SAP_WRITE: "" }).write).toBe("off");
    expect(policyFromEnv({ SAP_WRITE: " " }).write).toBe("off");
    expect(policyFromEnv({ SAP_ALLOW_LOGOFF: "" }).allowLogoff).toBe(false);
    expect(() => policyFromEnv({ SAP_WRITE: "yes" })).toThrow(/SAP_WRITE/);
  });

  test("values set in Claude Desktop reach the server", () => {
    const env = envFor({ SAP_WRITE: "confirm", SAP_ALLOW_SYSTEMS: "ABA/800, S4H", SAP_BLOCK_TCODES: "SE38" });
    const p = policyFromEnv(env);
    expect(p.write).toBe("confirm");
    expect(p.allowSystems).toEqual(["ABA/800", "S4H"]);
    expect(p.blockTcodes).toEqual(["SE38"]);
  });
});

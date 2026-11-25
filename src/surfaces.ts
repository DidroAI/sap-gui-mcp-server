/** The surfaces this machine can serve, from SAP_SURFACES (default: all that apply here). */
import type { Surface, SurfaceName } from "./core/types.js";
import { fioriSurface } from "./fiori/index.js";
import { sapguiSurface } from "./sapgui/index.js";
import { sapguiDiagSurface } from "./sapgui-diag/index.js";
import { webguiSurface } from "./webgui/index.js";

/**
 * SAP_GUI_METHOD picks how SAP GUI for Windows is read. Unset (auto), both run: scripting sees the sessions SAP GUI
 * scripting offers, the DIAG reader the connections that go through its router, and the agent works in whichever
 * session sap_sessions lists. `scripting` or `diag` keeps to one, for setups where nobody watches the agent.
 */
export const GUI_METHODS = ["auto", "scripting", "diag"] as const;

export function surfacesFromEnv(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): Surface[] {
  const all: SurfaceName[] = platform === "win32" ? ["sapgui", "webgui", "fiori"] : ["webgui", "fiori"];
  // Any case, spaces and empty entries ignored, each once: "WebGUI, fiori," is webgui and fiori.
  const named = [...new Set((env.SAP_SURFACES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))] as SurfaceName[];
  const wanted = named.length ? named : all;
  const method = (env.SAP_GUI_METHOD ?? "").trim().toLowerCase() || "auto";
  if (!(GUI_METHODS as readonly string[]).includes(method)) throw new Error(`SAP_GUI_METHOD must be auto, scripting or diag (got "${env.SAP_GUI_METHOD}")`);
  const out: Surface[] = [];
  for (const n of wanted) {
    if (n === "sapgui") {
      if (method !== "diag") out.push(sapguiSurface(env));
      if (method !== "scripting") out.push(sapguiDiagSurface(env));
    }
    else if (n === "webgui") out.push(webguiSurface(env));
    else if (n === "fiori") out.push(fioriSurface(env));
    else throw new Error(`Unknown surface "${n}" in SAP_SURFACES (sapgui, webgui, fiori)`);
  }
  return out;
}

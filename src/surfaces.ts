/** The surfaces this machine can serve, from SAP_SURFACES (default: all that apply here). */
import type { Surface, SurfaceName } from "./core/types.js";
import { fioriSurface } from "./fiori/index.js";
import { sapguiSurface } from "./sapgui/index.js";
import { sapguiDiagSurface } from "./sapgui-diag/index.js";
import { webguiSurface } from "./webgui/index.js";

export function surfacesFromEnv(env: Record<string, string | undefined> = process.env): Surface[] {
  const all: SurfaceName[] = process.platform === "win32" ? ["sapgui", "webgui", "fiori"] : ["webgui", "fiori"];
  const wanted = env.SAP_SURFACES ? (env.SAP_SURFACES.split(",").map((s) => s.trim()) as SurfaceName[]) : all;
  const out: Surface[] = [];
  for (const n of wanted) {
    if (n === "sapgui") out.push(env.SAP_GUI_METHOD === "diag" ? sapguiDiagSurface(env) : sapguiSurface(env));
    else if (n === "webgui") out.push(webguiSurface(env));
    else if (n === "fiori") out.push(fioriSurface(env));
    else throw new Error(`Unknown surface "${n}" in SAP_SURFACES (sapgui, webgui, fiori)`);
  }
  return out;
}

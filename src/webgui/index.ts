import type { Surface } from "../core/types.js";

/** Placeholder: the webgui surface is being ported. */
export function webguiSurface(_env: Record<string, string | undefined>): Surface {
  return {
    name: "webgui",
    discover: async () => [],
    open: async () => {
      throw new Error("webgui: not implemented yet");
    },
    doctor: async () => [{ ok: false, check: "webgui", detail: "not implemented yet" }],
  };
}

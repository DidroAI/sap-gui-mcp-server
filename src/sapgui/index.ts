import type { Surface } from "../core/types.js";

/** Placeholder: the sapgui surface is being ported. */
export function sapguiSurface(_env: Record<string, string | undefined>): Surface {
  return {
    name: "sapgui",
    discover: async () => [],
    open: async () => {
      throw new Error("sapgui: not implemented yet");
    },
    doctor: async () => [{ ok: false, check: "sapgui", detail: "not implemented yet" }],
  };
}

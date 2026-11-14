import type { Surface } from "../core/types.js";

/** Placeholder: the fiori surface is being ported. */
export function fioriSurface(_env: Record<string, string | undefined>): Surface {
  return {
    name: "fiori",
    discover: async () => [],
    open: async () => {
      throw new Error("fiori: not implemented yet");
    },
    doctor: async () => [{ ok: false, check: "fiori", detail: "not implemented yet" }],
  };
}

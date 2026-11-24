/**
 * Test files and configs are ES modules (`import { test } from
 * "sap-ui-automation/test"`), but Node decides a `.ts` or `.js` file's
 * module system from the nearest package.json. `npm init` writes
 * `"type": "commonjs"`, and then `sap.config.ts` fails with "Cannot use
 * import statement outside a module".
 *
 * This registers a load hook, once, that loads such files as ES modules:
 * every `.ts` file Node would load as CommonJS (not `.cts`), and `.sap.js` and
 * `sap.config.js`. An explicit `.cjs` or `.cts` stays CommonJS. Bun needs no
 * hook.
 */
import * as nodeModule from "node:module";

const HOOKS = `
const forced = (url) => {
  if (!url.startsWith("file:")) return false;
  const p = new URL(url).pathname;
  return /\\.ts$/.test(p) ? "module-typescript" : /(\\.sap|\\/sap\\.config)\\.js$/.test(p) ? "module" : false;
};
export async function load(url, context, next) {
  const r = await next(url, context);
  const to = forced(url);
  if (to && (r.format === "commonjs" || r.format === "commonjs-typescript")) return next(url, { ...context, format: to });
  return r;
}
`;

let registered = false;

/** Loads test files and configs as ES modules whatever the project's package.json says. Safe to call more than once. */
export function loadTestFilesAsModules(): void {
  if (registered || "Bun" in globalThis) return;
  registered = true;
  const register = (nodeModule as { register?: (specifier: string, parentURL?: string) => void }).register;
  if (!register) return;
  register(`data:text/javascript,${encodeURIComponent(HOOKS)}`, import.meta.url);
}

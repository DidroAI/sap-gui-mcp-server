/**
 * Stands in for `sap-gui-mcp-server/test` when a generated `*.sap.ts` is run
 * or type-checked in the tests: `test` keeps the function, `expect` is the SDK's.
 */
import { expect, type Sap } from "../src/sdk/index.js";

export { expect };

export type SapTestFn = (ctx: { sap: Sap }) => Promise<void>;
export const registered: { name: string; fn: SapTestFn }[] = [];

export function test(name: string, fn: SapTestFn): void {
  registered.push({ name, fn });
}

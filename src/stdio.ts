import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { disconnectChrome } from "./browser/chrome.js";
import { policyFromEnv } from "./core/guard.js";
import { createServer } from "./server.js";
import { surfacesFromEnv } from "./surfaces.js";

/** Runs the server on stdio until the client closes it. */
export async function serveStdio(env: Record<string, string | undefined> = process.env): Promise<void> {
  const { server, registry } = createServer({ policy: policyFromEnv(env), surfaces: surfacesFromEnv(env) });
  const close = async () => {
    await registry.closeAll();
    await disconnectChrome().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  process.stdin.on("close", close);
  await server.connect(new StdioServerTransport());
}

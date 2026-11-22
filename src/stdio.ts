import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { disconnectChrome, extensionMode } from "./browser/chrome.js";
import { policyFromEnv } from "./core/guard.js";
import { viewModeFromEnv } from "./core/views.js";
import { createServer } from "./server.js";
import { surfacesFromEnv } from "./surfaces.js";

/** Runs the server on stdio until the client closes it. */
export async function serveStdio(env: Record<string, string | undefined> = process.env): Promise<void> {
  const { server, registry } = createServer({ policy: policyFromEnv(env), surfaces: surfacesFromEnv(env), view: viewModeFromEnv(env) });
  const close = async () => {
    await registry.closeAll();
    await disconnectChrome().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  process.stdin.on("close", close);
  // Confirm mode with a client that cannot ask the user: every write will be refused. Said in the client's server log.
  server.server.oninitialized = () => {
    if (policyFromEnv(env).write === "confirm" && !server.server.getClientCapabilities()?.elicitation?.form)
      process.stderr.write("sap-gui: SAP_WRITE=confirm, but this client does not support MCP elicitation: actions that may write will be refused. Set SAP_WRITE=on and use the client's tool approval, or use a client that supports elicitation.\n");
  };
  // SAP_BROWSER=extension: the relay listens from the start, so the extension has paired before the first tool call.
  if (extensionMode(env)) void import("./browser/extension/index.js").then((m) => m.extensionRelay(env)).catch((e) => process.stderr.write(`sap-gui: ${(e as Error).message}\n`));
  await server.connect(new StdioServerTransport());
}

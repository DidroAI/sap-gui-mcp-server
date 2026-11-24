import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { disconnectChrome, extensionMode } from "./browser/chrome.js";
import { policyFromEnv } from "./core/guard.js";
import { viewModeFromEnv } from "./core/views.js";
import { createServer } from "./server.js";
import { surfacesFromEnv } from "./surfaces.js";

/** Runs the server on stdio until the client closes it. */
export async function serveStdio(env: Record<string, string | undefined> = process.env): Promise<void> {
  // SAP_BROWSER=extension: the systems registered in the extension, for sap_systems and sap_logon.
  const systems = extensionMode(env) ? (await import("./browser/extension/index.js")).systemsAccess : undefined;
  const surfaces = surfacesFromEnv(env);
  const { server, registry } = createServer({
    policy: policyFromEnv(env),
    surfaces,
    view: viewModeFromEnv(env),
    ...(systems ? { systems: systems(env) } : {}),
  });
  // Runs once, and gives up after 3 s: a host that hangs never keeps the server alive.
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const work = (async () => {
        await registry.closeAll().catch(() => {});
        await disconnectChrome().catch(() => {});
        await Promise.allSettled(surfaces.map((s) => s.close?.()));
      })();
      await Promise.race([work, new Promise((r) => setTimeout(r, 3000).unref())]);
      process.exit(0);
    })());
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

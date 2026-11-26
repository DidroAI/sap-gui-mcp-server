import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { disconnectChrome, extensionMode } from "./browser/chrome.js";
import { policyFromEnv } from "./core/guard.js";
import { viewModeFromEnv } from "./core/views.js";
import { createServer, SERVER_NAME } from "./server.js";
import { surfacesFromEnv } from "./surfaces.js";

/**
 * The line for the client's server log when writing is confirm and the client cannot ask the user
 * (no MCP elicitation): every write will be refused. Confirm is the default, so the line also says
 * how to get writes, and how to make the server read-only, which silences it.
 */
export function confirmLogNote(env: Record<string, string | undefined>, canElicit: boolean): string | undefined {
  if (canElicit || policyFromEnv(env).write !== "confirm") return undefined;
  const mode = env.SAP_WRITE?.trim() ? "SAP_WRITE=confirm" : "SAP_WRITE is confirm (the default)";
  return `${SERVER_NAME}: ${mode}, but this client does not support MCP elicitation, so it cannot ask you: actions that may write to SAP will be refused. To get writes, use a client that supports elicitation, or set SAP_WRITE=on on a test system and use the client's tool approval. Set SAP_WRITE=off to make the server read-only and drop this note.`;
}

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
    const note = confirmLogNote(env, !!server.server.getClientCapabilities()?.elicitation?.form);
    if (note) process.stderr.write(`${note}\n`);
  };
  // SAP_BROWSER=extension: the relay listens from the start, so the extension has paired before the first tool call.
  if (extensionMode(env)) void import("./browser/extension/index.js").then((m) => m.extensionRelay(env)).catch((e) => process.stderr.write(`${SERVER_NAME}: ${(e as Error).message}\n`));
  await server.connect(new StdioServerTransport());
}

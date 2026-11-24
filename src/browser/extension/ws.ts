/**
 * The `ws` WebSocket library that playwright-core already bundles (its exports
 * map lists `./lib/utilsBundle`), typed with the little the relay uses: no new
 * dependency. The bundle ships no types, so it is loaded with require.
 */
import { createRequire } from "node:module";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export interface WebSocket {
  readonly readyState: number;
  send(data: string | Buffer, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "open", listener: () => void): this;
  on(event: "unexpected-response", listener: (request: ClientRequest, response: IncomingMessage) => void): this;
  once(event: "close", listener: (code: number, reason: Buffer) => void): this;
  once(event: "open", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "unexpected-response", listener: (request: ClientRequest, response: IncomingMessage) => void): this;
}

interface WebSocketClass {
  new (url: string, options?: { headers?: Record<string, string>; origin?: string; maxPayload?: number }): WebSocket;
  readonly OPEN: number;
  readonly CONNECTING: number;
}

export interface WebSocketServer {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (ws: WebSocket) => void): void;
  close(callback?: () => void): void;
}

interface WebSocketServerClass {
  new (options: { noServer: true; maxPayload?: number }): WebSocketServer;
}

const bundle = createRequire(import.meta.url)("playwright-core/lib/utilsBundle") as { ws: WebSocketClass; wsServer: WebSocketServerClass };

export const WebSocket: WebSocketClass = bundle.ws;
export const WebSocketServer: WebSocketServerClass = bundle.wsServer;

/**
 * Raises the largest frame a socket takes. The extension's socket is opened with a small limit, so a
 * connection that has not paired cannot make the server hold a large frame; once paired it takes the
 * relay's full size. ws keeps the limit on the socket's receiver and reads it for each frame header.
 */
export function raiseMaxPayload(ws: WebSocket, bytes: number): boolean {
  const receiver = (ws as unknown as { _receiver?: { _maxPayload?: unknown } | null })._receiver;
  if (!receiver || typeof receiver._maxPayload !== "number") return false;
  receiver._maxPayload = bytes;
  return true;
}

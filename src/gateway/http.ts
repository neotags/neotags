import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "pino";

// The in-cluster HTTP port (o2Gateway.port): one server, routed by path prefix to the O2 gateway (/o2_agent/) and the
// internal API (/internal/v1/). Each route checks its own key and answers its own errors.

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** The JSON body, `{}` when empty. Over `maxBytes`: HttpError `tooLarge` (O2 expects 400; the internal API says 413). */
export async function readBody(req: IncomingMessage, maxBytes: number, tooLarge = 400): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Read to the end even when too large: leaving the loop early destroys the socket, and the caller would get a
  // reset instead of the error.
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= maxBytes) chunks.push(chunk as Buffer);
  }
  if (size > maxBytes) throw new HttpError(tooLarge, tooLarge === 413 ? "too_large" : "bad_request", `the request body is over ${Math.floor(maxBytes / 1024)} KB`);
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_request", "the request body is not JSON");
  }
}

/** A W3C `traceparent` (lower-case); group 1 is the trace id. */
export const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;

export function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "bad_request", "malformed path");
  }
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant time; hashing first makes the lengths equal. */
export function keyMatches(given: string | string[] | undefined, key: string): boolean {
  return typeof given === "string" && timingSafeEqual(digest(given), digest(key));
}

export const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
};

/** Handles one request under its prefix; answers its own errors (the O2 panel and the internal API differ). */
export type Route = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * The port's server: `GET /healthz`, and each request whose path starts with a route's prefix to that route.
 * Anything else is 404.
 */
export function createPortServer(o: { routes: Record<string, Route>; log: Pick<Logger, "error">; name: string }) {
  const { log } = o;
  const routes = Object.entries(o.routes);
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (req.method === "GET" && path === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    const route = routes.find(([prefix]) => path.startsWith(prefix))?.[1];
    if (!route) return sendJson(res, { detail: { code: "not_found", message: "not found" } }, 404);
    route(req, res).catch((err: unknown) => {
      // Routes answer their own errors; this is the last resort for a bug in one.
      if (res.destroyed || req.destroyed) return;
      log.error({ err }, `${o.name} request failed`);
      if (res.headersSent) return void res.end();
      sendJson(res, { detail: { code: "internal_error", message: "internal error" } }, 500);
    });
  });

  return {
    server,
    listen: (port: number, host?: string) =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          // After startup a server error (EMFILE on accept, ...) is logged; unhandled it would take the process down.
          server.on("error", (err) => log.error({ err }, `${o.name} server error`));
          resolve();
        });
      }),
    /** Stop accepting connections; open requests go on until their runs finish (the run manager drains them). */
    stopAccepting: () => {
      server.close();
      server.closeIdleConnections();
    },
    /** Close whatever is still open, after up to `graceMs` for responses that just ended to flush their last event. */
    close: async (graceMs = 2000) => {
      const closed = new Promise<void>((r) => server.once("close", () => r()));
      await Promise.race([closed, new Promise((r) => setTimeout(r, graceMs).unref())]);
      server.closeAllConnections();
    },
  };
}

export type PortServer = ReturnType<typeof createPortServer>;

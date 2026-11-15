import { createHash } from "node:crypto";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { z } from "zod";
import { dataPath, readData, writeData } from "./data";

// A loopback pass-through for Claude sessions. It exists to read the usage headers on model
// responses. Bodies stream untouched, and request headers (which hold the session's token) are
// forwarded without being logged or stored.

const HOST = "127.0.0.1";
const ANTHROPIC = "https://api.anthropic.com";
const ROUTE = /^\/r\/([0-9a-f]{16})(?=[/?]|$)/;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const StateSchema = z.object({
  port: z.number().int().optional(),
  routes: z.record(z.string(), z.string()).default({}),
});

function endToEnd(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name)));
}

export class HeaderProxy {
  private readonly statePath = dataPath("proxy.json");
  private readonly agents = {
    "http:": new http.Agent({ keepAlive: true, proxyEnv: process.env }),
    "https:": new https.Agent({ keepAlive: true, proxyEnv: process.env }),
  };
  private readonly server = http.createServer((req, res) => this.forward(req, res));
  private routes: Record<string, string> = {};
  private starting: Promise<void> | null = null;
  private port: number | null = null;

  constructor(private readonly onResponse: (headers: IncomingHttpHeaders) => void) {
    // Model responses stream for minutes; only the idle keep-alive needs a limit.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 0;
    this.server.keepAliveTimeout = 65_000;
  }

  /** Listens once. A failed start can be tried again at the next session open. */
  start(): Promise<void> {
    this.starting ??= this.listenOnSavedPort().catch((error: unknown) => {
      this.starting = null;
      throw error;
    });
    return this.starting;
  }

  stop(): void {
    this.server.closeAllConnections();
    this.server.close();
    this.agents["http:"].destroy();
    this.agents["https:"].destroy();
    this.port = null;
  }

  /** Whether a base URL already points at this proxy. */
  owns(baseUrl: string): boolean {
    try {
      const url = new URL(baseUrl);
      return url.hostname === HOST && Number(url.port) === this.port;
    } catch {
      return false;
    }
  }

  /**
   * The base URL a session should use to reach `upstream` through the proxy, or null if it
   * cannot be routed. Upstreams carrying credentials are refused so none are written to disk.
   */
  async routeFor(upstream: string | null): Promise<string | null> {
    if (this.port === null) return null;
    const root = `http://${HOST}:${this.port}`;
    if (upstream === null) return root;
    let url: URL;
    try {
      url = new URL(upstream);
    } catch {
      return null;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search) {
      return null;
    }
    const id = createHash("sha256").update(upstream).digest("hex").slice(0, 16);
    if (this.routes[id] !== upstream) {
      this.routes[id] = upstream;
      await this.save();
    }
    return `${root}/r/${id}`;
  }

  private async listenOnSavedPort(): Promise<void> {
    const saved = StateSchema.safeParse(await readData(this.statePath));
    if (saved.success) this.routes = saved.data.routes;
    // The same port lets sessions still open across a plugin reload reconnect.
    const preferred = saved.success ? saved.data.port : undefined;
    if (!preferred || !(await this.listen(preferred))) {
      if (!(await this.listen(0))) throw new Error("could not open a loopback port");
    }
    const address = this.server.address();
    this.port = address && typeof address === "object" ? address.port : null;
    await this.save();
  }

  private listen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const failed = () => resolve(false);
      this.server.once("error", failed);
      this.server.listen(port, HOST, () => {
        this.server.off("error", failed);
        resolve(true);
      });
    });
  }

  private save(): Promise<void> {
    return writeData(this.statePath, { port: this.port, routes: this.routes });
  }

  /** Where a request should go, or null for a route this proxy does not know. */
  private target(path: string): URL | null {
    const match = ROUTE.exec(path);
    if (!match) return new URL(path, ANTHROPIC);
    const upstream = this.routes[match[1]];
    if (!upstream) return null;
    const base = new URL(upstream);
    const rest = new URL(path.slice(match[0].length) || "/", ANTHROPIC);
    base.pathname = base.pathname.replace(/\/+$/, "") + rest.pathname;
    base.search = rest.search;
    return base;
  }

  private forward(req: IncomingMessage, res: ServerResponse): void {
    const fail = (status: number, message: string) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message } }));
    };

    const target = this.target(req.url ?? "/");
    if (!target) {
      req.resume();
      fail(404, "Load Balancer does not know this route");
      return;
    }

    const protocol = target.protocol === "http:" ? "http:" : "https:";
    const send = protocol === "http:" ? http.request : https.request;
    const upstream = send(
      {
        protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        method: req.method,
        path: target.pathname + target.search,
        headers: { ...endToEnd(req.headers), host: target.host },
        agent: this.agents[protocol],
      },
      (response) => {
        try {
          this.onResponse(response.headers);
        } catch (error) {
          console.error("[Load Balancer] could not read usage headers", error instanceof Error ? error.message : "");
        }
        res.writeHead(response.statusCode ?? 502, endToEnd(response.headers));
        response.on("error", () => res.destroy());
        response.pipe(res);
      },
    );
    upstream.on("error", () => fail(502, "Load Balancer could not reach the upstream API"));
    req.on("error", () => upstream.destroy());
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  }
}

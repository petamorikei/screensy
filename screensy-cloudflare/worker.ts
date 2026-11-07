/**
 * screensy on Cloudflare Workers. The Worker serves the page in the language of the browser, Static Assets serve the
 * other files, and one Durable Object runs every room with rooms.ts of the rendezvous server, like the Node.js server
 * does. The Durable Object does not hibernate: the rooms live in its memory while anyone is connected.
 */
import { DurableObject } from "cloudflare:workers";
import type { ConnectionHandlers } from "screensy-rendezvous/rooms";
import { configFromEnv, MAX_PAYLOAD_BYTES, RoomServer } from "screensy-rendezvous/rooms";
import * as z from "zod";
import { pickLanguage } from "./language.ts";

// Workers do not allow new Function, which Zod would otherwise try for faster parsers
z.config({ jitless: true });

type Env = {
  readonly ASSETS: Fetcher;
  readonly RENDEZVOUS: DurableObjectNamespace<Rendezvous>;
  // The SCREENSY_* variables of rooms.ts come from "vars" in wrangler.jsonc
  readonly [name: `SCREENSY_${string}`]: string | undefined;
};

const encoder = new TextEncoder();

export class Rendezvous extends DurableObject<Env> {
  private readonly rooms: RoomServer | null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const { config, errors } = configFromEnv(env);

    for (const error of errors) {
      console.error(error);
    }

    this.rooms = errors.length > 0 ? null : new RoomServer(config);
  }

  override fetch(request: Request): Response {
    if (this.rooms == null) {
      return new Response("The configuration of the server is invalid, see its log.", { status: 500 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    const handlers: ConnectionHandlers = this.rooms.connect(
      {
        send: (data) => {
          if (server.readyState === WebSocket.READY_STATE_OPEN) {
            server.send(data);
          }
        },
        close: () => server.close(1000),
        drop: () => server.close(4000, "No answer to ping"),
      },
      new URL(request.url).hostname,
    );

    server.addEventListener("message", (event) => {
      // Binary messages are never valid
      if (typeof event.data !== "string") {
        return;
      }

      // Like maxPayload of ws
      if (encoder.encode(event.data).byteLength > MAX_PAYLOAD_BYTES) {
        server.close(1009, "Message too big");
        handlers.closed(1009);
        return;
      }

      handlers.message(event.data);
    });
    server.addEventListener("close", (event) => handlers.closed(event.code));
    server.addEventListener("error", () => handlers.closed(1006));

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  fetch: async (request, env) => {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return env.RENDEZVOUS.getByName("rendezvous").fetch(request);
    }

    const url = new URL(request.url);

    // Static Assets serve every other path without the Worker (run_worker_first in wrangler.jsonc)
    if (url.pathname !== "/" && url.pathname !== "/index.html") {
      return env.ASSETS.fetch(request);
    }

    const language = pickLanguage(request.headers.get("Accept-Language"));
    const page = await env.ASSETS.fetch(new Request(new URL(`/translations/${language}.html`, url), request));
    const response = new Response(page.body, page);

    // Revalidate on every load, so that a cached screensy.js never talks to a newer server (like the Go server)
    response.headers.set("Cache-Control", "no-cache");
    response.headers.append("Vary", "Accept-Language");

    return response;
  },
} satisfies ExportedHandler<Env>;

/**
 * The rendezvous server on Node.js: a WebSocket server on port 4000 that runs the rooms of rooms.ts.
 */
import type { IncomingMessage } from "node:http";
import type { RawData } from "ws";
import { WebSocket, WebSocketServer } from "ws";
import { configFromEnv, hostnameOf, MAX_PAYLOAD_BYTES, RoomServer } from "./rooms.ts";

const PORT = 4000;

/**
 * The main entry point.
 */
const main = (): void => {
  const { config, errors } = configFromEnv(process.env);

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }

    process.exit(1);
  }

  const webSocketServer = new WebSocketServer({ port: PORT, maxPayload: MAX_PAYLOAD_BYTES });
  const rooms = new RoomServer(config);

  webSocketServer.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    // ws emits "error" (and then "close") for protocol violations such as an oversized payload. Without a listener,
    // the error would crash the process.
    socket.on("error", () => {});

    const handlers = rooms.connect(
      {
        send: (data) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(data);
          }
        },
        close: () => socket.close(),
        drop: () => socket.terminate(),
      },
      hostnameOf(request.headers.host),
    );

    socket.on("message", (data: RawData) => handlers.message(data.toString()));
    socket.on("close", (code: number) => handlers.closed(code));
  });

  console.log(`Server started on port ${PORT}`);
};

main();

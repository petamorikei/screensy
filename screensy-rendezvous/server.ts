import { createHmac, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type {
  ClientMessage,
  DisconnectReason,
  IceServer,
  MessageJoin,
  MessageRoomState,
  MessageSignalToServer,
  PresenterState,
  ServerMessage,
} from "screensy-protocol";
import { ClientMessageSchema, JoinSchema } from "screensy-protocol";
import type { RawData } from "ws";
import { WebSocket, WebSocketServer } from "ws";

/**
 * Reads a positive integer from an environment variable. Used to shorten the timers when testing. Defined first,
 * because the constants below use it.
 */
const numberFromEnv = (name: string, fallback: number): number => {
  const value = Number.parseInt(process.env[name] ?? "", 10);

  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

/**
 * Reads a comma-separated list from an environment variable: the fallback if the variable is not set, and no entries
 * if it is empty
 */
const listFromEnv = (name: string, fallback: string[]): string[] => {
  const value = process.env[name];

  return value === undefined
    ? fallback
    : value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
};

const PORT = 4000;

/**
 * How long a presenter whose page closed its socket keeps their seat, so that they can resume after a reload. Closing
 * the tab looks the same, so this is kept short.
 */
const LEFT_GRACE_MS = numberFromEnv("SCREENSY_LEFT_GRACE_MS", 30_000);

/**
 * How long a presenter whose connection broke keeps their seat, for example after a network change or a sleeping
 * laptop. Their page still holds the capture and resumes without a click when it reconnects.
 */
const LOST_GRACE_MS = numberFromEnv("SCREENSY_LOST_GRACE_MS", 300_000);

/**
 * The close codes of a socket that the page closed on purpose: 1000 (normal), 1001 (going away, sent by the browser
 * when the page unloads) and 1005 (a close frame without a code, sent by close() without arguments). Every other code,
 * such as 1006 for a connection that ended without a close frame, means that the connection broke.
 */
const CLEAN_CLOSE_CODES = new Set([1000, 1001, 1005]);

/**
 * How often the server pings each client. A client that has not answered the previous ping is terminated.
 */
const PING_INTERVAL_MS = numberFromEnv("SCREENSY_PING_INTERVAL_MS", 15_000);

/**
 * The number of people that can present at the same time. In a full room, a new presenter has to name the presenter
 * to take over.
 */
const MAX_PRESENTERS = numberFromEnv("SCREENSY_MAX_PRESENTERS", 4);

const MAX_NAME_LENGTH = 32;
const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * The STUN and TURN servers that clients use. "{host}" stands for the host name that the client connected to, like
 * location.hostname on the page. An empty variable turns them off, for example SCREENSY_STUN_URLS="" where the host
 * runs no STUN server.
 */
const STUN_URLS = listFromEnv("SCREENSY_STUN_URLS", ["stun:{host}"]);
const TURN_URLS = listFromEnv("SCREENSY_TURN_URLS", ["turn:{host}"]);

/**
 * The secret shared with coturn (use-auth-secret, static-auth-secret). The server signs a temporary TURN username with
 * it for every "welcome". Without it, clients get no TURN server.
 */
const TURN_SECRET = process.env.SCREENSY_TURN_SECRET || null;

/**
 * How long a temporary TURN username stays valid. A connection refreshes its relay with the username it started with,
 * so this has to outlast a long presentation.
 */
const TURN_TTL_S = numberFromEnv("SCREENSY_TURN_TTL_S", 86_400);

/**
 * A presenter seat as the room stores it. The remaining grace period is computed from the participant when sent.
 */
type Presenter = Omit<PresenterState, "graceRemainingMs">;

interface Participant {
  readonly id: string;
  readonly resumeToken: string;
  name: string;
  connectionId: string;
  socket: WebSocket | null;
  graceTimer: NodeJS.Timeout | null;
  /**
   * When the grace timer fires, in Date.now() time
   */
  graceDeadline: number | null;
}

/**
 * The main entry point.
 */
const main = (): void => {
  const webSocketServer = new WebSocketServer({ port: PORT, maxPayload: MAX_PAYLOAD_BYTES });
  const server = new Server();
  const alive = new WeakSet<WebSocket>();

  webSocketServer.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    alive.add(socket);
    socket.on("pong", () => alive.add(socket));
    // ws emits "error" (and then "close") for protocol violations such as an oversized payload. Without a listener,
    // the error would crash the process.
    socket.on("error", () => {});
    server.onConnection(socket, hostnameOf(request.headers.host));
  });

  const heartbeat = setInterval(() => {
    for (const socket of webSocketServer.clients) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }

      alive.delete(socket);
      socket.ping();
    }
  }, PING_INTERVAL_MS);

  webSocketServer.on("close", () => clearInterval(heartbeat));

  if (TURN_SECRET == null) {
    console.warn("SCREENSY_TURN_SECRET is not set, so clients get no TURN server.");
  }

  console.log(`Server started on port ${PORT}`);
};

class Server {
  private readonly rooms = new Map<string, Room>();

  /**
   * Handles a new WebSocket connection. The first valid message must be a "join".
   *
   * @param hostname The host name that the client connected to, or null if its Host header is missing or invalid
   */
  onConnection(socket: WebSocket, hostname: string | null): void {
    const onFirstMessage = (data: RawData) => {
      const message = parseJoin(data);

      if (message == null) {
        // No messages are valid until a client has sent a "join"
        return;
      }

      socket.off("message", onFirstMessage);

      const roomId = message.roomId;
      let room = this.rooms.get(roomId);

      if (room == null) {
        room = new Room(() => this.rooms.delete(roomId));
        this.rooms.set(roomId, room);
      }

      room.join(socket, message, hostname);
    };

    socket.on("message", onFirstMessage);
  }
}

/**
 * Represents a screensharing room. It lives as long as it has a participant, connected or within the grace period.
 */
class Room {
  private readonly participants = new Map<string, Participant>();
  private presenters: Presenter[] = [];

  private nextParticipantId = 0;
  private nextConnectionId = 0;
  private nextStreamId = 0;

  private readonly onEmpty: () => void;

  /**
   * @param onEmpty Called when the last participant has left
   */
  constructor(onEmpty: () => void) {
    this.onEmpty = onEmpty;
  }

  /**
   * Adds a socket to the room, either as a new participant or as the participant of its resume token.
   */
  join(socket: WebSocket, message: MessageJoin, hostname: string | null): void {
    let participant = this.findByResumeToken(message.resumeToken);

    if (participant == null) {
      participant = {
        id: (this.nextParticipantId++).toString(),
        resumeToken: randomUUID(),
        name: "",
        connectionId: "",
        socket: null,
        graceTimer: null,
        graceDeadline: null,
      };

      this.participants.set(participant.id, participant);
    } else {
      if (participant.socket != null) {
        this.replaceSocket(participant);
      }

      // Back within the grace period. A seat is kept without a time limit until the participant resumes or frees it.
      clearGrace(participant);
    }

    participant.name = normalizeName(message.name);
    participant.connectionId = (this.nextConnectionId++).toString();
    this.attach(participant, socket);

    send(socket, {
      type: "welcome",
      selfId: participant.id,
      connectionId: participant.connectionId,
      resumeToken: participant.resumeToken,
      maxPresenters: MAX_PRESENTERS,
      iceServers: iceServersFor(hostname, participant.id),
    });

    this.broadcastState();
  }

  private findByResumeToken(resumeToken: string | undefined): Participant | undefined {
    if (resumeToken == null) {
      return undefined;
    }

    for (const participant of this.participants.values()) {
      if (participant.resumeToken === resumeToken) {
        return participant;
      }
    }

    return undefined;
  }

  /**
   * Detaches the current socket of the participant, because another socket joined with its resume token.
   */
  private replaceSocket(participant: Participant): void {
    const oldSocket = participant.socket;

    if (oldSocket == null) {
      return;
    }

    oldSocket.removeAllListeners("message");
    oldSocket.removeAllListeners("close");
    participant.socket = null;

    send(oldSocket, { type: "replaced" });
    oldSocket.close();

    // The old page owned the capture. The new page has to resume it.
    const presenter = this.presenterOf(participant.id);

    if (presenter != null) {
      presenter.status = "reconnecting";
      presenter.disconnectReason = "left";
    }
  }

  private attach(participant: Participant, socket: WebSocket): void {
    participant.socket = socket;

    socket.on("message", (data: RawData) => {
      const message = parseClientMessage(data);

      if (message != null) {
        this.handleMessage(participant, message);
      }
    });

    socket.on("close", (code: number) => {
      // A replaced socket may close after its replacement has joined
      if (participant.socket === socket) {
        this.handleDisconnect(participant, CLEAN_CLOSE_CODES.has(code) ? "left" : "lost");
      }
    });
  }

  private handleMessage(participant: Participant, message: ClientMessage): void {
    switch (message.type) {
      case "setname":
        participant.name = normalizeName(message.name);
        this.broadcastState();
        break;
      case "present":
        this.present(participant, message.resume, message.replace);
        break;
      case "stoppresenting":
        this.removePresenter(participant.id);
        this.broadcastState();
        break;
      case "streamstate": {
        const presenter = this.presenterOf(participant.id);

        if (presenter != null && presenter.streamId === message.streamId) {
          presenter.hidden = message.hidden;
          this.broadcastState();
        }

        break;
      }
      case "signal":
        this.relaySignal(participant, message);
        break;
    }
  }

  private present(participant: Participant, resume: boolean, replace: string | undefined): void {
    let presenter = this.presenterOf(participant.id);

    if (resume && presenter == null) {
      // Someone else took the seat while the sender was disconnected
      sendTo(participant, { type: "presentrejected", reason: "seat-lost" });
      return;
    }

    if (presenter == null && this.presenters.length >= MAX_PRESENTERS) {
      // A full room only takes a new presenter in place of one that the sender chose
      const replaced = replace === undefined || replace === participant.id ? undefined : this.presenterOf(replace);

      if (replaced == null) {
        sendTo(participant, { type: "presentrejected", reason: "full" });
        return;
      }

      this.removePresenter(replaced.participantId);
    }

    const streamId = (this.nextStreamId++).toString();

    if (presenter == null) {
      presenter = { participantId: participant.id, streamId, hidden: false, status: "live", disconnectReason: null };
      this.presenters.push(presenter);
    } else {
      presenter.streamId = streamId;
      presenter.hidden = false;
      presenter.status = "live";
      presenter.disconnectReason = null;
    }

    sendTo(participant, { type: "presentaccepted", streamId });
    this.broadcastState();
  }

  /**
   * Removes the presenter seat of the participant. A participant that only stayed for the grace period is removed
   * too.
   */
  private removePresenter(participantId: string): void {
    this.presenters = this.presenters.filter((presenter) => presenter.participantId !== participantId);

    const participant = this.participants.get(participantId);

    if (participant != null && participant.socket == null) {
      this.removeParticipant(participant);
    }
  }

  private removeParticipant(participant: Participant): void {
    clearGrace(participant);
    this.participants.delete(participant.id);
    this.presenters = this.presenters.filter((presenter) => presenter.participantId !== participant.id);
  }

  private relaySignal(sender: Participant, message: MessageSignalToServer): void {
    const recipient = this.participants.get(message.to);

    if (
      recipient == null ||
      recipient.socket == null ||
      recipient.id === sender.id ||
      recipient.connectionId !== message.toConnection
    ) {
      return;
    }

    const presenter = this.presenters.find((presenter) => presenter.streamId === message.streamId);

    if (presenter == null) {
      return;
    }

    if (presenter.participantId !== sender.id && presenter.participantId !== recipient.id) {
      // Viewers may not signal each other
      return;
    }

    // The stream ID and the WebRTC payload (kind and message) go through as they are
    const { to: _to, toConnection: _toConnection, ...signal } = message;
    send(recipient.socket, { ...signal, from: sender.id, fromConnection: sender.connectionId });
  }

  private handleDisconnect(participant: Participant, reason: DisconnectReason): void {
    participant.socket = null;

    const presenter = this.presenterOf(participant.id);

    if (presenter == null) {
      this.removeParticipant(participant);
    } else {
      const graceMs = reason === "left" ? LEFT_GRACE_MS : LOST_GRACE_MS;

      presenter.status = "reconnecting";
      presenter.disconnectReason = reason;
      clearGrace(participant);
      participant.graceDeadline = Date.now() + graceMs;
      participant.graceTimer = setTimeout(() => {
        participant.graceTimer = null;
        participant.graceDeadline = null;
        this.removeParticipant(participant);
        this.broadcastState();
        this.closeIfEmpty();
      }, graceMs);
    }

    this.broadcastState();
    this.closeIfEmpty();
  }

  private closeIfEmpty(): void {
    if (this.participants.size === 0) {
      this.onEmpty();
    }
  }

  private presenterOf(participantId: string): Presenter | undefined {
    return this.presenters.find((presenter) => presenter.participantId === participantId);
  }

  private broadcastState(): void {
    const now = Date.now();
    const graceRemainingMs = (participantId: string): number | null => {
      const deadline = this.participants.get(participantId)?.graceDeadline;
      return deadline == null ? null : Math.max(0, deadline - now);
    };

    const message: MessageRoomState = {
      type: "roomstate",
      participants: [...this.participants.values()].map((participant) => ({
        id: participant.id,
        connectionId: participant.connectionId,
        name: participant.name,
        connected: participant.socket != null,
      })),
      presenters: this.presenters.map((presenter) => ({
        ...presenter,
        graceRemainingMs: graceRemainingMs(presenter.participantId),
      })),
    };

    for (const participant of this.participants.values()) {
      sendTo(participant, message);
    }
  }
}

const clearGrace = (participant: Participant): void => {
  if (participant.graceTimer != null) {
    clearTimeout(participant.graceTimer);
  }

  participant.graceTimer = null;
  participant.graceDeadline = null;
};

const send = (socket: WebSocket, message: ServerMessage): void => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
};

const sendTo = (participant: Participant, message: ServerMessage): void => {
  if (participant.socket != null) {
    send(participant.socket, message);
  }
};

/**
 * Parses a WebSocket message as JSON. Returns undefined if it is not valid JSON.
 */
const parseMessage = (data: RawData): unknown => {
  try {
    return JSON.parse(data.toString());
  } catch {
    return undefined;
  }
};

/**
 * Returns the message if it is a valid "join", or null
 */
const parseJoin = (data: RawData): MessageJoin | null => JoinSchema.safeParse(parseMessage(data)).data ?? null;

/**
 * Returns the message if it is a valid message after "join", or null
 */
const parseClientMessage = (data: RawData): ClientMessage | null =>
  ClientMessageSchema.safeParse(parseMessage(data)).data ?? null;

/**
 * The host name of a Host header, without the port, or null if it is missing or invalid. ws lets through values such
 * as "[", on which new URL throws: this must never throw, because one bad request would stop the whole server.
 */
const hostnameOf = (host: string | undefined): string | null => {
  if (host == null || host === "") {
    return null;
  }

  try {
    const hostname = new URL(`http://${host}`).hostname;
    return hostname === "" ? null : hostname;
  } catch {
    return null;
  }
};

/**
 * The STUN and TURN servers for a client. The TURN username follows the TURN REST API of coturn: the time it expires
 * (in Unix seconds), a colon and a name, signed with HMAC-SHA1 and the shared secret.
 */
const iceServersFor = (hostname: string | null, participantId: string): IceServer[] => {
  // URLs with "{host}" are left out when the host name is unknown
  const resolve = (urls: string[]): string[] =>
    urls.flatMap((url) => {
      if (!url.includes("{host}")) {
        return [url];
      }

      return hostname == null ? [] : [url.replaceAll("{host}", hostname)];
    });

  const servers: IceServer[] = [];
  const stun = resolve(STUN_URLS);
  const turn = resolve(TURN_URLS);

  if (stun.length > 0) {
    servers.push({ urls: stun });
  }

  if (TURN_SECRET != null && turn.length > 0) {
    const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_S}:${participantId}`;
    const credential = createHmac("sha1", TURN_SECRET).update(username).digest("base64");
    servers.push({ urls: turn, username, credential });
  }

  return servers;
};

/**
 * Trims the name and limits it to MAX_NAME_LENGTH code points.
 */
const normalizeName = (name: string): string => [...name.trim()].slice(0, MAX_NAME_LENGTH).join("").trim();

main();

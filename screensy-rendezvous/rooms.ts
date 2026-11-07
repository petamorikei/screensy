/**
 * The rooms of the rendezvous server, without a runtime: the Node.js server (server.ts) and the Cloudflare Worker
 * (screensy-cloudflare) both run them through a small socket interface. Nothing here may import ws or node:* modules,
 * or read process.env.
 */
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

/**
 * The largest message that a server accepts. A larger one closes the socket.
 */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

const MAX_NAME_LENGTH = 32;

/**
 * The close codes of a socket that the page closed on purpose: 1000 (normal), 1001 (going away, sent by the browser
 * when the page unloads) and 1005 (a close frame without a code, sent by close() without arguments). Every other code,
 * such as 1006 for a connection that ended without a close frame, means that the connection broke.
 */
const CLEAN_CLOSE_CODES = new Set([1000, 1001, 1005]);

export interface RoomConfig {
  /**
   * How long a presenter whose page closed its socket keeps their seat, so that they can resume after a reload.
   * Closing the tab looks the same, so this is kept short.
   */
  readonly leftGraceMs: number;
  /**
   * How long a presenter whose connection broke keeps their seat, for example after a network change or a sleeping
   * laptop. Their page still holds the capture and resumes without a click when it reconnects.
   */
  readonly lostGraceMs: number;
  /**
   * How often the server sends "ping" to each client. A client that has sent nothing since the previous ping is
   * dropped.
   */
  readonly pingIntervalMs: number;
  /**
   * The number of people that can present at the same time. In a full room, a new presenter has to name the
   * presenter to take over.
   */
  readonly maxPresenters: number;
  /**
   * The STUN servers that clients use. "{host}" stands for the host name that the client connected to, like
   * location.hostname on the page.
   */
  readonly stunUrls: readonly string[];
}

/**
 * Environment variables, or the bindings of a Worker (which also holds objects that are not strings)
 */
type Env = Readonly<Record<string, unknown>>;

const stringFromEnv = (env: Env, name: string): string | undefined => {
  const value = env[name];
  return typeof value === "string" ? value : undefined;
};

/**
 * Reads a positive integer from an environment variable. Used to shorten the timers when testing.
 */
const numberFromEnv = (env: Env, name: string, fallback: number): number => {
  const value = Number.parseInt(stringFromEnv(env, name) ?? "", 10);

  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

/**
 * Reads a comma-separated list from an environment variable: the fallback if the variable is not set, and no entries
 * if it is empty
 */
const listFromEnv = (env: Env, name: string, fallback: string[]): string[] => {
  const value = stringFromEnv(env, name);

  return value === undefined
    ? fallback
    : value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
};

// The syntax of STUN URLs (RFC 7064): a scheme, a host and an optional port. A browser throws on anything else when it
// creates a connection, which would break every connection without a message to the person who runs the server. So
// the servers refuse to start with a mistake.
const STUN_URL = /^stuns?:(\[[0-9a-fA-F:.]+\]|[^\s:/?#[\]@]+)(:\d{1,5})?$/;

/**
 * Reads the configuration from the SCREENSY_* variables. The errors describe the variables that are invalid.
 */
export const configFromEnv = (env: Env): { config: RoomConfig; errors: string[] } => {
  // An empty variable turns STUN off, for example SCREENSY_STUN_URLS="" where the host runs no STUN server
  const stunUrls = listFromEnv(env, "SCREENSY_STUN_URLS", ["stun:{host}"]);
  // {host} stands for a host name, so check the URLs with one in its place
  const invalid = stunUrls.filter((url) => !STUN_URL.test(url.replaceAll("{host}", "example.com")));

  return {
    config: {
      leftGraceMs: numberFromEnv(env, "SCREENSY_LEFT_GRACE_MS", 30_000),
      lostGraceMs: numberFromEnv(env, "SCREENSY_LOST_GRACE_MS", 300_000),
      pingIntervalMs: numberFromEnv(env, "SCREENSY_PING_INTERVAL_MS", 15_000),
      maxPresenters: numberFromEnv(env, "SCREENSY_MAX_PRESENTERS", 4),
      stunUrls,
    },
    errors: invalid.length > 0 ? [`SCREENSY_STUN_URLS has invalid URLs: ${invalid.join(", ")}`] : [],
  };
};

/**
 * A WebSocket as the runtime provides it
 */
export interface ClientSocket {
  /**
   * Sends a text message. Does nothing if the socket is no longer open.
   */
  send(data: string): void;
  /**
   * Closes the socket normally
   */
  close(): void;
  /**
   * Ends a connection that stopped answering, without waiting for a close handshake
   */
  drop(): void;
}

/**
 * What the runtime calls for the events of a socket that it passed to RoomServer.connect
 */
export interface ConnectionHandlers {
  message(data: string): void;
  closed(code: number): void;
}

interface Connection {
  readonly socket: ClientSocket;
  readonly hostname: string | null;
  /**
   * Whether the client sent anything since the last ping
   */
  alive: boolean;
  /**
   * Set by a valid "join"
   */
  participant: Participant | null;
  room: Room | null;
  /**
   * Closed, dropped or replaced: its late events are ignored
   */
  ended: boolean;
}

/**
 * A presenter seat as the room stores it. The remaining grace period is computed from the participant when sent.
 */
type Presenter = Omit<PresenterState, "graceRemainingMs">;

interface Participant {
  readonly id: string;
  readonly resumeToken: string;
  name: string;
  connectionId: string;
  connection: Connection | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  /**
   * When the grace timer fires, in Date.now() time
   */
  graceDeadline: number | null;
}

/**
 * Every room, and the heartbeat of every connection
 */
export class RoomServer {
  private readonly config: RoomConfig;
  private readonly rooms = new Map<string, Room>();
  private readonly connections = new Set<Connection>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(config: RoomConfig) {
    this.config = config;
  }

  /**
   * Starts handling a new WebSocket connection. The first valid message must be a "join".
   *
   * @param hostname The host name that the client connected to, or null if it is unknown
   */
  connect(socket: ClientSocket, hostname: string | null): ConnectionHandlers {
    const connection: Connection = { socket, hostname, alive: true, participant: null, room: null, ended: false };

    this.connections.add(connection);
    this.startHeartbeat();

    return {
      message: (data) => this.onMessage(connection, data),
      closed: (code) => this.onClosed(connection, code),
    };
  }

  private onMessage(connection: Connection, data: string): void {
    if (connection.ended) {
      return;
    }

    // Any message shows that the client is there, even an invalid one
    connection.alive = true;

    const { participant, room } = connection;

    if (participant == null || room == null) {
      const message = parseJoin(data);

      // No messages are valid until a client has sent a "join"
      if (message != null) {
        this.roomFor(message.roomId).join(connection, message);
      }

      return;
    }

    const message = parseClientMessage(data);

    if (message != null) {
      room.handleMessage(participant, message);
    }
  }

  private onClosed(connection: Connection, code: number): void {
    if (connection.ended) {
      return;
    }

    this.end(connection);
    connection.room?.disconnect(connection, CLEAN_CLOSE_CODES.has(code) ? "left" : "lost");
  }

  private roomFor(roomId: string): Room {
    let room = this.rooms.get(roomId);

    if (room == null) {
      room = new Room(
        this.config,
        () => this.rooms.delete(roomId),
        (connection) => this.end(connection),
      );
      this.rooms.set(roomId, room);
    }

    return room;
  }

  /**
   * Stops handling the events of the connection
   */
  private end(connection: Connection): void {
    connection.ended = true;
    this.connections.delete(connection);

    // An idle server has no timer, so that a Durable Object without clients can be evicted
    if (this.connections.size === 0 && this.heartbeat != null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeat != null) {
      return;
    }

    this.heartbeat = setInterval(() => {
      for (const connection of [...this.connections]) {
        if (connection.alive) {
          connection.alive = false;
          send(connection, { type: "ping" });
          continue;
        }

        // The client sent nothing, not even a "pong", since the previous ping: the connection broke without a close
        this.end(connection);
        connection.socket.drop();
        connection.room?.disconnect(connection, "lost");
      }
    }, this.config.pingIntervalMs);
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

  private readonly config: RoomConfig;
  private readonly onEmpty: () => void;
  private readonly release: (connection: Connection) => void;

  /**
   * @param onEmpty Called when the last participant has left
   * @param release Called for a connection that the room closes, so that its late events are ignored
   */
  constructor(config: RoomConfig, onEmpty: () => void, release: (connection: Connection) => void) {
    this.config = config;
    this.onEmpty = onEmpty;
    this.release = release;
  }

  /**
   * Adds a connection to the room, either as a new participant or as the participant of its resume token.
   */
  join(connection: Connection, message: MessageJoin): void {
    let participant = this.findByResumeToken(message.resumeToken);

    if (participant == null) {
      participant = {
        id: (this.nextParticipantId++).toString(),
        resumeToken: crypto.randomUUID(),
        name: "",
        connectionId: "",
        connection: null,
        graceTimer: null,
        graceDeadline: null,
      };

      this.participants.set(participant.id, participant);
    } else {
      if (participant.connection != null) {
        this.replaceConnection(participant);
      }

      // Back within the grace period. A seat is kept without a time limit until the participant resumes or frees it.
      clearGrace(participant);
    }

    participant.name = normalizeName(message.name);
    participant.connectionId = (this.nextConnectionId++).toString();
    participant.connection = connection;
    connection.participant = participant;
    connection.room = this;

    send(connection, {
      type: "welcome",
      selfId: participant.id,
      connectionId: participant.connectionId,
      resumeToken: participant.resumeToken,
      maxPresenters: this.config.maxPresenters,
      iceServers: iceServersFor(this.config.stunUrls, connection.hostname),
    });

    this.broadcastState();
  }

  /**
   * Handles the end of a connection of this room. A connection that was already replaced does not count.
   */
  disconnect(connection: Connection, reason: DisconnectReason): void {
    const participant = connection.participant;

    if (participant != null && participant.connection === connection) {
      this.handleDisconnect(participant, reason);
    }
  }

  handleMessage(participant: Participant, message: ClientMessage): void {
    switch (message.type) {
      case "pong":
        // Only shows that the client is there
        break;
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
   * Closes the current connection of the participant, because another connection joined with its resume token.
   */
  private replaceConnection(participant: Participant): void {
    const old = participant.connection;

    if (old == null) {
      return;
    }

    this.release(old);
    participant.connection = null;

    send(old, { type: "replaced" });
    old.socket.close();

    // The old page owned the capture. The new page has to resume it.
    const presenter = this.presenterOf(participant.id);

    if (presenter != null) {
      presenter.status = "reconnecting";
      presenter.disconnectReason = "left";
    }
  }

  private present(participant: Participant, resume: boolean, replace: string | undefined): void {
    let presenter = this.presenterOf(participant.id);

    if (resume && presenter == null) {
      // Someone else took the seat while the sender was disconnected
      sendTo(participant, { type: "presentrejected", reason: "seat-lost" });
      return;
    }

    if (presenter == null && this.presenters.length >= this.config.maxPresenters) {
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

    if (participant != null && participant.connection == null) {
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
      recipient.connection == null ||
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
    send(recipient.connection, { ...signal, from: sender.id, fromConnection: sender.connectionId });
  }

  private handleDisconnect(participant: Participant, reason: DisconnectReason): void {
    participant.connection = null;

    const presenter = this.presenterOf(participant.id);

    if (presenter == null) {
      this.removeParticipant(participant);
    } else {
      const graceMs = reason === "left" ? this.config.leftGraceMs : this.config.lostGraceMs;

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
        connected: participant.connection != null,
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

const send = (connection: Connection, message: ServerMessage): void => {
  connection.socket.send(JSON.stringify(message));
};

const sendTo = (participant: Participant, message: ServerMessage): void => {
  if (participant.connection != null) {
    send(participant.connection, message);
  }
};

/**
 * Parses a WebSocket message as JSON. Returns undefined if it is not valid JSON.
 */
const parseMessage = (data: string): unknown => {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
};

/**
 * Returns the message if it is a valid "join", or null
 */
const parseJoin = (data: string): MessageJoin | null => JoinSchema.safeParse(parseMessage(data)).data ?? null;

/**
 * Returns the message if it is a valid message after "join", or null
 */
const parseClientMessage = (data: string): ClientMessage | null =>
  ClientMessageSchema.safeParse(parseMessage(data)).data ?? null;

/**
 * The host name of a Host header, without the port, or null if it is missing or invalid. ws lets through values such
 * as "[", on which new URL throws: this must never throw, because one bad request would stop the whole server.
 */
export const hostnameOf = (host: string | undefined): string | null => {
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
 * The STUN servers for a client. URLs with "{host}" are left out when the host name is unknown.
 */
const iceServersFor = (stunUrls: readonly string[], hostname: string | null): IceServer[] => {
  const urls = stunUrls.flatMap((url) => {
    if (!url.includes("{host}")) {
      return [url];
    }

    return hostname == null ? [] : [url.replaceAll("{host}", hostname)];
  });

  return urls.length > 0 ? [{ urls }] : [];
};

/**
 * Trims the name and limits it to MAX_NAME_LENGTH code points.
 */
const normalizeName = (name: string): string => [...name.trim()].slice(0, MAX_NAME_LENGTH).join("").trim();

import { randomUUID } from "node:crypto";
import type { RawData } from "ws";
import { WebSocket, WebSocketServer } from "ws";

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
 * The number of people that can present at the same time. When a new presenter exceeds it, the oldest presenter is
 * removed.
 */
const MAX_PRESENTERS = 1;

const MAX_NAME_LENGTH = 32;
const MAX_ROOM_ID_LENGTH = 256;
const MAX_PAYLOAD_BYTES = 64 * 1024;

type SignalKind = "offer" | "answer" | "candidate";

// Messages from the client to the server

/**
 * Joins a room. A resume token from an earlier "welcome" takes over that participant.
 */
interface MessageJoin {
  type: "join";
  roomId: string;
  name: string;
  resumeToken?: string;
}

interface MessageSetName {
  type: "setname";
  name: string;
}

/**
 * Starts presenting, after the client has captured its screen. With resume, the server only accepts it when the
 * sender still holds a presenter seat.
 */
interface MessagePresent {
  type: "present";
  resume: boolean;
}

interface MessageStopPresenting {
  type: "stoppresenting";
}

interface MessageStreamState {
  type: "streamstate";
  streamId: string;
  hidden: boolean;
}

/**
 * Sends a WebRTC message to another participant. Either the sender or the recipient must be the presenter of the
 * stream.
 */
interface MessageSignalToServer {
  type: "signal";
  to: string;
  toConnection: string;
  streamId: string;
  kind: SignalKind;
  message: unknown;
}

type ClientMessage =
  | MessageSetName
  | MessagePresent
  | MessageStopPresenting
  | MessageStreamState
  | MessageSignalToServer;

// Messages from the server to the client

interface MessageWelcome {
  type: "welcome";
  selfId: string;
  connectionId: string;
  resumeToken: string;
}

interface ParticipantState {
  id: string;
  connectionId: string;
  name: string;
  connected: boolean;
}

/**
 * Why a presenter seat is reconnecting: "left" if the page closed its socket (a reload or a closed tab), "lost" if the
 * connection broke.
 */
type DisconnectReason = "left" | "lost";

interface PresenterState {
  participantId: string;
  streamId: string;
  hidden: boolean;
  status: "live" | "reconnecting";
  /**
   * Null while the seat is live
   */
  disconnectReason: DisconnectReason | null;
  /**
   * The time left before the seat is freed, or null if no grace period runs. A presenter who has reconnected but not
   * resumed yet keeps the seat without a time limit.
   */
  graceRemainingMs: number | null;
}

/**
 * A presenter seat as the room stores it. The remaining grace period is computed from the participant when sent.
 */
type Presenter = Omit<PresenterState, "graceRemainingMs">;

interface MessageRoomState {
  type: "roomstate";
  participants: ParticipantState[];
  presenters: PresenterState[];
}

interface MessageSignalFromServer {
  type: "signal";
  from: string;
  fromConnection: string;
  streamId: string;
  kind: SignalKind;
  message: unknown;
}

interface MessagePresentAccepted {
  type: "presentaccepted";
  streamId: string;
}

interface MessagePresentRejected {
  type: "presentrejected";
}

/**
 * Tells a socket that another socket has joined with its resume token.
 */
interface MessageReplaced {
  type: "replaced";
}

type ServerMessage =
  | MessageWelcome
  | MessageRoomState
  | MessageSignalFromServer
  | MessagePresentAccepted
  | MessagePresentRejected
  | MessageReplaced;

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
function main(): void {
  const webSocketServer = new WebSocketServer({ port: PORT, maxPayload: MAX_PAYLOAD_BYTES });
  const server = new Server();
  const alive = new WeakSet<WebSocket>();

  webSocketServer.on("connection", (socket: WebSocket) => {
    alive.add(socket);
    socket.on("pong", () => alive.add(socket));
    // ws emits "error" (and then "close") for protocol violations such as an oversized payload. Without a listener,
    // the error would crash the process.
    socket.on("error", () => {});
    server.onConnection(socket);
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

  console.log(`Server started on port ${PORT}`);
}

class Server {
  private readonly rooms = new Map<string, Room>();

  /**
   * Handles a new WebSocket connection. The first valid message must be a "join".
   */
  onConnection(socket: WebSocket): void {
    const onFirstMessage = (data: RawData) => {
      const message = parseMessage(data);

      if (!instanceOfMessageJoin(message)) {
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

      room.join(socket, message);
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
  join(socket: WebSocket, message: MessageJoin): void {
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
      const message = parseMessage(data);

      if (instanceOfClientMessage(message)) {
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
        this.present(participant, message.resume);
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

  private present(participant: Participant, resume: boolean): void {
    let presenter = this.presenterOf(participant.id);

    if (resume && presenter == null) {
      // Someone else took the seat while the sender was disconnected
      sendTo(participant, { type: "presentrejected" });
      return;
    }

    const streamId = (this.nextStreamId++).toString();

    if (presenter == null) {
      while (this.presenters.length >= MAX_PRESENTERS) {
        const oldest = this.presenters[0];
        this.removePresenter(oldest.participantId);
      }

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

    send(recipient.socket, {
      type: "signal",
      from: sender.id,
      fromConnection: sender.connectionId,
      streamId: message.streamId,
      kind: message.kind,
      message: message.message,
    });
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

function clearGrace(participant: Participant): void {
  if (participant.graceTimer != null) {
    clearTimeout(participant.graceTimer);
  }

  participant.graceTimer = null;
  participant.graceDeadline = null;
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function sendTo(participant: Participant, message: ServerMessage): void {
  if (participant.socket != null) {
    send(participant.socket, message);
  }
}

/**
 * Parses a WebSocket message as JSON. Returns undefined if it is not valid JSON.
 */
function parseMessage(data: RawData): unknown {
  try {
    return JSON.parse(data.toString());
  } catch {
    return undefined;
  }
}

/**
 * Trims the name and limits it to MAX_NAME_LENGTH code points.
 */
function normalizeName(name: unknown): string {
  if (typeof name !== "string") {
    return "";
  }

  return [...name.trim()].slice(0, MAX_NAME_LENGTH).join("").trim();
}

/**
 * Reads a positive integer from an environment variable. Used to shorten the timers when testing.
 */
function numberFromEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);

  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Returns true if and only if the given value is a non-null, non-array object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function instanceOfKind(value: unknown): value is SignalKind {
  return value === "offer" || value === "answer" || value === "candidate";
}

function instanceOfMessageJoin(object: unknown): object is MessageJoin {
  if (!isObject(object)) {
    return false;
  }

  const goodType = object.type === "join";
  const goodRoomId =
    typeof object.roomId === "string" && object.roomId.length >= 1 && object.roomId.length <= MAX_ROOM_ID_LENGTH;
  const goodName = typeof object.name === "string";
  const goodResumeToken = object.resumeToken === undefined || typeof object.resumeToken === "string";

  return goodType && goodRoomId && goodName && goodResumeToken;
}

function instanceOfClientMessage(object: unknown): object is ClientMessage {
  if (!isObject(object)) {
    return false;
  }

  switch (object.type) {
    case "setname":
      return typeof object.name === "string";
    case "present":
      return typeof object.resume === "boolean";
    case "stoppresenting":
      return true;
    case "streamstate":
      return typeof object.streamId === "string" && typeof object.hidden === "boolean";
    case "signal":
      return (
        typeof object.to === "string" &&
        typeof object.toConnection === "string" &&
        typeof object.streamId === "string" &&
        instanceOfKind(object.kind) &&
        "message" in object
      );
    default:
      return false;
  }
}

main();

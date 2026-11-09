/**
 * The signaling protocol of screensy. The server (screensy-rendezvous) and the browser client (screensy-website)
 * share these schemas: each side parses every message it receives with them and drops the invalid ones.
 */
import * as z from "zod";

/**
 * The longest room ID that the server accepts
 */
export const MAX_ROOM_ID_LENGTH = 256;

// The WebRTC payload of a signal, discriminated by its kind. The schemas name every field of RTCSessionDescriptionInit
// and RTCIceCandidateInit, so stripping the unknown ones loses nothing.

const SessionDescriptionSchema = z.object({
  type: z.enum(["offer", "answer", "pranswer", "rollback"]),
  sdp: z.string().optional(),
});

/**
 * RTCIceCandidate.toJSON() sets the fields that it does not know to null
 */
const IceCandidateSchema = z.object({
  candidate: z.string().optional(),
  sdpMid: z.string().nullish(),
  sdpMLineIndex: z.number().int().nonnegative().nullish(),
  usernameFragment: z.string().nullish(),
});

const signalPayloads = {
  offer: { kind: z.literal("offer"), message: SessionDescriptionSchema },
  answer: { kind: z.literal("answer"), message: SessionDescriptionSchema },
  candidate: { kind: z.literal("candidate"), message: IceCandidateSchema },
};

// Messages from the client to the server

/**
 * Joins a room. A resume token from an earlier "welcome" takes over that participant.
 */
export const JoinSchema = z.object({
  type: z.literal("join"),
  roomId: z.string().min(1).max(MAX_ROOM_ID_LENGTH),
  name: z.string(),
  resumeToken: z.string().optional(),
});

const SetNameSchema = z.object({
  type: z.literal("setname"),
  name: z.string(),
});

/**
 * Starts presenting, after the client has captured its screen. With resume, the server only accepts it when the
 * sender still holds a presenter seat.
 */
const PresentSchema = z.object({
  type: z.literal("present"),
  resume: z.boolean(),
  /**
   * The presenter to take over when the room has reached the limit of presenters. Ignored below the limit.
   */
  replace: z.string().optional(),
});

/**
 * The answer to "ping"
 */
const PongSchema = z.object({
  type: z.literal("pong"),
});

const StopPresentingSchema = z.object({
  type: z.literal("stoppresenting"),
});

const StreamStateSchema = z.object({
  type: z.literal("streamstate"),
  streamId: z.string(),
  hidden: z.boolean(),
});

/**
 * Joins the call. Every participant in the call sends a stream of their microphone, and of their camera while it is on,
 * to everyone in the room, including those who are not in the call. A participant already in the call joins again with
 * a new stream. The camera is subject to the limit of cameras, like in "callstate".
 */
const JoinCallSchema = z.object({
  type: z.literal("joincall"),
  muted: z.boolean(),
  camera: z.boolean(),
});

const LeaveCallSchema = z.object({
  type: z.literal("leavecall"),
});

/**
 * Whether the sender's microphone is muted and their camera is on. Ignored if the sender is not in the call. A camera
 * beyond the limit of cameras stays off, and the server answers "camerarejected".
 */
const CallStateToServerSchema = z.object({
  type: z.literal("callstate"),
  muted: z.boolean(),
  camera: z.boolean(),
});

/**
 * Sends a WebRTC message to another participant through the server. Either the sender or the recipient must own the
 * stream: its presenter, or the participant in the call who sends it.
 */
const signalToServer = { type: z.literal("signal"), to: z.string(), toConnection: z.string(), streamId: z.string() };
const SignalToServerSchema = z.discriminatedUnion("kind", [
  z.object({ ...signalToServer, ...signalPayloads.offer }),
  z.object({ ...signalToServer, ...signalPayloads.answer }),
  z.object({ ...signalToServer, ...signalPayloads.candidate }),
]);

/**
 * Sends a WebRTC message of the mesh: the connection without media that every two connected participants keep, for
 * the chat. Unlike "signal", it belongs to no stream, and any participant may send it to any other.
 */
const meshSignalToServer = { type: z.literal("meshsignal"), to: z.string(), toConnection: z.string() };
const MeshSignalToServerSchema = z.discriminatedUnion("kind", [
  z.object({ ...meshSignalToServer, ...signalPayloads.offer }),
  z.object({ ...meshSignalToServer, ...signalPayloads.answer }),
  z.object({ ...meshSignalToServer, ...signalPayloads.candidate }),
]);

/**
 * Every message after "join"
 */
export const ClientMessageSchema = z.discriminatedUnion("type", [
  PongSchema,
  SetNameSchema,
  PresentSchema,
  StopPresentingSchema,
  StreamStateSchema,
  JoinCallSchema,
  LeaveCallSchema,
  CallStateToServerSchema,
  SignalToServerSchema,
  MeshSignalToServerSchema,
]);

// Messages from the server to the client

/**
 * STUN servers, as RTCIceServer
 */
const IceServerSchema = z.object({
  urls: z.array(z.string()).min(1),
});

const WelcomeSchema = z.object({
  type: z.literal("welcome"),
  selfId: z.string(),
  connectionId: z.string(),
  resumeToken: z.string(),
  /**
   * A random ID of this room, new whenever the room is created again: after everyone left, or after the server
   * restarted. The chat history that a page keeps belongs to one of them.
   */
  roomInstanceId: z.string(),
  /**
   * The number of people that can present at the same time
   */
  maxPresenters: z.number().int().positive(),
  /**
   * The number of cameras that can be on at the same time
   */
  maxCameras: z.number().int().positive(),
  /**
   * The STUN servers for new WebRTC connections, chosen by the server's configuration
   */
  iceServers: z.array(IceServerSchema),
});

const ParticipantStateSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  name: z.string(),
  connected: z.boolean(),
});

/**
 * Why a presenter seat is reconnecting: "left" if the page closed its socket (a reload or a closed tab), "lost" if the
 * connection broke.
 */
const DisconnectReasonSchema = z.enum(["left", "lost"]);

const PresenterStateSchema = z.object({
  participantId: z.string(),
  streamId: z.string(),
  hidden: z.boolean(),
  status: z.enum(["live", "reconnecting"]),
  /**
   * Null while the seat is live
   */
  disconnectReason: DisconnectReasonSchema.nullable(),
  /**
   * The time left before the seat is freed, or null if no grace period runs. A duration, so that the clocks of the
   * server and the client need not agree.
   */
  graceRemainingMs: z.number().nonnegative().nullable(),
});

/**
 * A participant in the call and the stream of their microphone and camera
 */
const CallStateSchema = z.object({
  participantId: z.string(),
  streamId: z.string(),
  muted: z.boolean(),
  camera: z.boolean(),
});

const RoomStateSchema = z.object({
  type: z.literal("roomstate"),
  participants: z.array(ParticipantStateSchema),
  presenters: z.array(PresenterStateSchema),
  /**
   * The participants in the voice call, in the order of joining
   */
  calls: z.array(CallStateSchema),
});

/**
 * A WebRTC message from another participant. The server sets "from" and "fromConnection".
 */
const signalFromServer = {
  type: z.literal("signal"),
  from: z.string(),
  fromConnection: z.string(),
  streamId: z.string(),
};
const SignalFromServerSchema = z.discriminatedUnion("kind", [
  z.object({ ...signalFromServer, ...signalPayloads.offer }),
  z.object({ ...signalFromServer, ...signalPayloads.answer }),
  z.object({ ...signalFromServer, ...signalPayloads.candidate }),
]);

/**
 * A WebRTC message of the mesh from another participant. The server sets "from" and "fromConnection".
 */
const meshSignalFromServer = { type: z.literal("meshsignal"), from: z.string(), fromConnection: z.string() };
const MeshSignalFromServerSchema = z.discriminatedUnion("kind", [
  z.object({ ...meshSignalFromServer, ...signalPayloads.offer }),
  z.object({ ...meshSignalFromServer, ...signalPayloads.answer }),
  z.object({ ...meshSignalFromServer, ...signalPayloads.candidate }),
]);

const PresentAcceptedSchema = z.object({
  type: z.literal("presentaccepted"),
  streamId: z.string(),
});

const PresentRejectedSchema = z.object({
  type: z.literal("presentrejected"),
  /**
   * "seat-lost": a resume, but the seat is gone. "full": the room has reached the limit of presenters, and "replace"
   * does not name one of the presenters.
   */
  reason: z.enum(["seat-lost", "full"]),
});

/**
 * The room has reached the limit of cameras: the sender's camera stays off
 */
const CameraRejectedSchema = z.object({
  type: z.literal("camerarejected"),
});

/**
 * The heartbeat. The client answers "pong". A client that sends nothing between two pings is dropped. The server sends
 * it, because browsers delay the timers of background tabs, but not the messages that they receive.
 */
const PingSchema = z.object({
  type: z.literal("ping"),
});

/**
 * Another socket has joined with this client's resume token, for example from a duplicated tab.
 */
const ReplacedSchema = z.object({
  type: z.literal("replaced"),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  PingSchema,
  WelcomeSchema,
  RoomStateSchema,
  SignalFromServerSchema,
  MeshSignalFromServerSchema,
  PresentAcceptedSchema,
  PresentRejectedSchema,
  CameraRejectedSchema,
  ReplacedSchema,
]);

export type SignalKind = z.infer<typeof SignalToServerSchema>["kind"];
export type IceServer = z.infer<typeof IceServerSchema>;
export type MessageJoin = z.infer<typeof JoinSchema>;
export type MessageSignalToServer = z.infer<typeof SignalToServerSchema>;
export type MessageMeshSignalToServer = z.infer<typeof MeshSignalToServerSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type MessageWelcome = z.infer<typeof WelcomeSchema>;
export type ParticipantState = z.infer<typeof ParticipantStateSchema>;
export type DisconnectReason = z.infer<typeof DisconnectReasonSchema>;
export type PresenterState = z.infer<typeof PresenterStateSchema>;
export type CallState = z.infer<typeof CallStateSchema>;
export type MessageRoomState = z.infer<typeof RoomStateSchema>;
export type MessageSignalFromServer = z.infer<typeof SignalFromServerSchema>;
export type MessageMeshSignalFromServer = z.infer<typeof MeshSignalFromServerSchema>;
export type MessagePresentAccepted = z.infer<typeof PresentAcceptedSchema>;
export type MessagePresentRejected = z.infer<typeof PresentRejectedSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

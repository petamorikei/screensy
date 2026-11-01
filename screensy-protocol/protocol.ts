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

const StopPresentingSchema = z.object({
  type: z.literal("stoppresenting"),
});

const StreamStateSchema = z.object({
  type: z.literal("streamstate"),
  streamId: z.string(),
  hidden: z.boolean(),
});

/**
 * Sends a WebRTC message to another participant through the server. Either the sender or the recipient must be the
 * presenter of the stream.
 */
const signalToServer = { type: z.literal("signal"), to: z.string(), toConnection: z.string(), streamId: z.string() };
const SignalToServerSchema = z.discriminatedUnion("kind", [
  z.object({ ...signalToServer, ...signalPayloads.offer }),
  z.object({ ...signalToServer, ...signalPayloads.answer }),
  z.object({ ...signalToServer, ...signalPayloads.candidate }),
]);

/**
 * Every message after "join"
 */
export const ClientMessageSchema = z.discriminatedUnion("type", [
  SetNameSchema,
  PresentSchema,
  StopPresentingSchema,
  StreamStateSchema,
  SignalToServerSchema,
]);

// Messages from the server to the client

/**
 * A STUN or TURN server, as RTCIceServer. A TURN server comes with a temporary username and credential.
 */
const IceServerSchema = z.object({
  urls: z.array(z.string()).min(1),
  username: z.string().optional(),
  credential: z.string().optional(),
});

const WelcomeSchema = z.object({
  type: z.literal("welcome"),
  selfId: z.string(),
  connectionId: z.string(),
  resumeToken: z.string(),
  /**
   * The number of people that can present at the same time
   */
  maxPresenters: z.number().int().positive(),
  /**
   * The STUN and TURN servers for new WebRTC connections, chosen by the server's configuration
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

const RoomStateSchema = z.object({
  type: z.literal("roomstate"),
  participants: z.array(ParticipantStateSchema),
  presenters: z.array(PresenterStateSchema),
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
 * Another socket has joined with this client's resume token, for example from a duplicated tab.
 */
const ReplacedSchema = z.object({
  type: z.literal("replaced"),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  WelcomeSchema,
  RoomStateSchema,
  SignalFromServerSchema,
  PresentAcceptedSchema,
  PresentRejectedSchema,
  ReplacedSchema,
]);

export type SignalKind = z.infer<typeof SignalToServerSchema>["kind"];
export type IceServer = z.infer<typeof IceServerSchema>;
export type MessageJoin = z.infer<typeof JoinSchema>;
export type MessageSignalToServer = z.infer<typeof SignalToServerSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type MessageWelcome = z.infer<typeof WelcomeSchema>;
export type ParticipantState = z.infer<typeof ParticipantStateSchema>;
export type DisconnectReason = z.infer<typeof DisconnectReasonSchema>;
export type PresenterState = z.infer<typeof PresenterStateSchema>;
export type MessageRoomState = z.infer<typeof RoomStateSchema>;
export type MessageSignalFromServer = z.infer<typeof SignalFromServerSchema>;
export type MessagePresentAccepted = z.infer<typeof PresentAcceptedSchema>;
export type MessagePresentRejected = z.infer<typeof PresentRejectedSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

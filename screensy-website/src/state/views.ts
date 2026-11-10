import type { DeviceChoice, DeviceKind, DeviceOption } from "../devices.ts";
import type { QualitySettings } from "../quality.ts";
import type { ConnectionStats, StatsDirection } from "../stats.ts";

/**
 * What the views show, as the controllers build it. The React components read it from the atoms in atoms.ts, and
 * call the controllers for what the person does.
 */

/**
 * What the whole page shows over the stage
 */
export type StatusId = "connecting" | "server-reconnecting" | "waiting";

/**
 * A browser that lacks something screensy needs, or a server that the page never reached
 */
export type UnsupportedId = "websocket" | "webrtc" | "mediastream" | "websocket-failed";

/**
 * What a tile shows over its video
 */
export type TileStatusId =
  | "joining"
  | "presenter-left"
  | "presenter-lost"
  | "presenter-resuming"
  | "presenter-hidden"
  | "self-hidden";

/**
 * A presentation, or the camera of a participant in the call
 */
export type TileKind = "screen" | "camera";

/**
 * One tile on the stage: a presentation, or a camera
 */
export interface TileView {
  /**
   * The presenter's participant ID, or "camera:" and the participant ID, so that the tile, its sound setting and its
   * enlargement stay the same when the participant starts a new stream
   */
  key: string;
  kind: TileKind;
  name: string;
  self: boolean;
  stream: MediaStream | null;
  status: TileStatusId | null;
  countdown: string | null;
  /**
   * The participant speaks in the call: only for cameras
   */
  speaking: boolean;
}

export interface ToolbarView {
  /**
   * Connected to the room, or presenting while the server is away
   */
  visible: boolean;
  canPresent: boolean;
  presenting: boolean;
  hidden: boolean;
  blurred: boolean;
  canBlur: boolean;
  /**
   * A switch or a blur change is in progress
   */
  busy: boolean;
  viewers: number;
}

export interface DialogView {
  /**
   * "start" to start presenting, "resume" to resume after a reload
   */
  mode: "start" | "resume";
  /**
   * In a full room, its limit and the presenters to choose from, one of whom is taken over; otherwise null
   */
  full: { maxPresenters: number; presenters: { id: string; name: string }[] } | null;
  /**
   * The name to fill in
   */
  name: string;
}

/**
 * A file of a chat message: what this page can do with it. "own": this page shares it. "ended": this page shared it
 * before a reload, which forgot it. "stopped": nobody here has it, but its sender is here. "unreachable": nobody here
 * has it. "receiving" has the progress, from 0 to 1, and "done" the URL to save it from.
 */
export interface ChatFileView {
  id: string;
  name: string;
  /**
   * The size, formatted
   */
  size: string;
  status: "own" | "ended" | "stopped" | "unreachable" | "idle" | "receiving" | "done" | "failed";
  progress: number;
  url: string | null;
}

export interface ChatEntryView {
  /**
   * The author and the number of the message, unique in the chat
   */
  key: string;
  name: string;
  /**
   * The time on the author's clock, in milliseconds since the epoch
   */
  sentAt: number;
  /**
   * Empty for a file without a text
   */
  text: string;
  self: boolean;
  file: ChatFileView | null;
}

export interface ChatView {
  entries: ChatEntryView[];
  /**
   * The chat knows its room and the server is there
   */
  enabled: boolean;
  /**
   * The other connected participants that the chat reaches, of all of them
   */
  open: number;
  total: number;
  /**
   * Counts the live messages from others, for the unread count
   */
  liveCount: number;
}

export interface CallMemberView {
  id: string;
  name: string;
  muted: boolean;
  camera: boolean;
  speaking: boolean;
}

export interface CallView {
  /**
   * Connected to the room
   */
  ready: boolean;
  /**
   * The browser can capture a microphone
   */
  supported: boolean;
  /**
   * This client is in the call
   */
  joined: boolean;
  /**
   * Asking for the microphone to join the call
   */
  joining: boolean;
  muted: boolean;
  /**
   * The own camera is on, or being turned on
   */
  camera: boolean;
  /**
   * Asking for the camera, or waiting for the room to accept it
   */
  cameraBusy: boolean;
  members: CallMemberView[];
  /**
   * The received streams of the call, by stream ID, to play
   */
  audio: { key: string; stream: MediaStream }[];
  /**
   * The person chose to share their sound instead of hearing the call on this page
   */
  audioMuted: boolean;
  /**
   * Ask whether to hear the call or to share the sound that would carry it back
   */
  echoChoice: boolean;
}

export interface DevicesView {
  supported: boolean;
  canChooseSpeaker: boolean;
  lists: Record<DeviceKind, DeviceOption[]>;
  choice: DeviceChoice;
}

export interface ParticipantView {
  id: string;
  name: string;
  you: boolean;
  presenting: boolean;
  reconnecting: boolean;
  inCall: boolean;
}

export interface StatsEntryView {
  /**
   * The kind of connection and the participant: the same participant can be both sent to and received from
   */
  key: string;
  name: string;
  direction: StatsDirection;
  stats: ConnectionStats;
}

export interface QualityView {
  /**
   * The browser can present
   */
  visible: boolean;
  settings: QualitySettings;
}

export interface StageView {
  tiles: TileView[];
  status: StatusId | null;
  /**
   * This presenter's capture may contain this page's sound, so the other presenters are muted
   */
  echoMuted: boolean;
}

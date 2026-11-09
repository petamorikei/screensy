/**
 * What the whole page shows over the stage
 */
export type StatusId = "status-connecting" | "status-server-reconnecting" | "status-waiting";

export const STATUS_IDS: StatusId[] = ["status-connecting", "status-server-reconnecting", "status-waiting"];

/**
 * What a tile shows over its presentation. The values are the data-status attributes in #tile-template.
 */
export type TileStatusId =
  | "status-joining"
  | "status-presenter-left"
  | "status-presenter-lost"
  | "status-presenter-resuming"
  | "status-presenter-hidden"
  | "status-self-hidden";

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

export type NoticeId =
  | "notice-taken-over"
  | "notice-moved-to-other-tab"
  | "notice-connection-lost"
  | "notice-access-denied"
  | "notice-switch-failed"
  | "notice-blur-failed"
  | "notice-full"
  | "notice-echo-muted"
  | "notice-microphone-denied"
  | "notice-call-audio-blocked"
  | "notice-camera-denied"
  | "notice-cameras-full";

export type DialogMode = "start" | "resume";

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
 * One presentation on the stage
 */
export interface TileView {
  /**
   * The presenter's participant ID, so that the tile, its sound setting and its enlargement stay the same when the
   * presenter starts a new stream
   */
  key: string;
  name: string;
  self: boolean;
  stream: MediaStream | null;
  status: TileStatusId | null;
  countdown: string | null;
}

export type NoticeId =
  | "notice-taken-over"
  | "notice-moved-to-other-tab"
  | "notice-connection-lost"
  | "notice-access-denied"
  | "notice-switch-failed"
  | "notice-blur-failed"
  | "notice-full"
  | "notice-echo-muted";

export type DialogMode = "start" | "resume";

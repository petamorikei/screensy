import type { CallState, MessageRoomState, PresenterState } from "screensy-protocol";
import { formatCountdown } from "./format.ts";
import type { TileView } from "./state/views.ts";

/**
 * What the tiles are built from: the client's own state, beside the room state
 */
export interface TileContext {
  selfId: string | null;
  /**
   * The own presentation, or null while not presenting
   */
  outgoing: { previewStream: MediaStream; hidden: boolean } | null;
  /**
   * The received stream of a presentation or of a call, or null before its first track
   */
  incomingStream: (streamId: string) => MediaStream | null;
  nameOf: (participantId: string) => string;
  /**
   * When the grace period of a reconnecting presenter ends, in performance.now() time
   */
  graceDeadline: (participantId: string) => number | undefined;
  /**
   * The own camera, once the room has accepted it, or null
   */
  ownCamera: MediaStream | null;
  /**
   * Whether a participant in the call speaks
   */
  speaking: (participantId: string) => boolean;
}

/**
 * The state in the call of a participant, or null outside of it
 */
const callStateOf = (context: TileContext, calls: CallState[], participantId: string | null) => {
  const call = calls.find((call) => call.participantId === participantId);
  return call == null ? null : { muted: call.muted, speaking: context.speaking(call.participantId) };
};

/**
 * The own presentation. Without the room state (while the server is away), it shows no call.
 */
export const ownTile = (context: TileContext, state: MessageRoomState | null): TileView => ({
  key: context.selfId ?? "self",
  kind: "screen",
  participantId: context.selfId,
  name: "",
  self: true,
  stream: context.outgoing?.previewStream ?? null,
  status: context.outgoing?.hidden ? "self-hidden" : null,
  countdown: null,
  call: callStateOf(context, state?.calls ?? [], context.selfId),
});

const remoteTile = (context: TileContext, state: MessageRoomState, presenter: PresenterState): TileView => {
  const tile: TileView = {
    key: presenter.participantId,
    kind: "screen",
    participantId: presenter.participantId,
    name: context.nameOf(presenter.participantId),
    self: false,
    stream: null,
    status: null,
    countdown: null,
    call: callStateOf(context, state.calls, presenter.participantId),
  };

  if (presenter.status === "reconnecting") {
    const participant = state.participants.find((participant) => participant.id === presenter.participantId);
    const deadline = context.graceDeadline(presenter.participantId);

    if (participant?.connected) {
      // Back after a reload, choosing the screen again
      tile.status = "presenter-resuming";
    } else {
      tile.status = presenter.disconnectReason === "lost" ? "presenter-lost" : "presenter-left";
      tile.countdown = deadline == null ? null : formatCountdown(deadline - performance.now());
    }

    return tile;
  }

  // While hidden, the stream stays attached: it is black and silent
  tile.stream = context.incomingStream(presenter.streamId);

  if (presenter.hidden) {
    tile.status = "presenter-hidden";
  } else if (tile.stream == null) {
    tile.status = "joining";
  }

  return tile;
};

/**
 * One tile per presenter, in the order of the room. The own tile takes the own seat, or comes last while the server
 * has not accepted the presentation yet.
 */
export const tileViews = (context: TileContext, state: MessageRoomState): TileView[] => {
  const tiles: TileView[] = [];
  let ownTileShown = false;

  for (const presenter of state.presenters) {
    if (presenter.participantId === context.selfId) {
      // Without a capture, the own seat is waiting in the resume dialog
      if (context.outgoing != null) {
        tiles.push(ownTile(context, state));
        ownTileShown = true;
      }

      continue;
    }

    tiles.push(remoteTile(context, state, presenter));
  }

  if (context.outgoing != null && !ownTileShown) {
    tiles.push(ownTile(context, state));
  }

  return tiles;
};

const cameraTile = (context: TileContext, state: MessageRoomState, call: CallState): TileView | null => {
  const self = call.participantId === context.selfId;
  const stream = self ? context.ownCamera : context.incomingStream(call.streamId);

  // The own camera shows once the page sends it
  if (self && stream == null) {
    return null;
  }

  return {
    key: `camera:${call.participantId}`,
    kind: "camera",
    participantId: call.participantId,
    name: self ? "" : context.nameOf(call.participantId),
    self,
    stream,
    status: stream == null ? "joining" : null,
    countdown: null,
    call: callStateOf(context, state.calls, call.participantId),
  };
};

/**
 * One tile per camera that is on, in the order of the call, after the presentations
 */
export const cameraTileViews = (context: TileContext, state: MessageRoomState): TileView[] =>
  state.calls.flatMap((call) => {
    const tile = call.camera ? cameraTile(context, state, call) : null;
    return tile == null ? [] : [tile];
  });

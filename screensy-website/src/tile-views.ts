import type { MessageRoomState, PresenterState } from "screensy-protocol";
import { formatCountdown } from "./format.ts";
import type { TileView } from "./ui/types.ts";

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
   * The received stream of a presentation, or null before its first track
   */
  incomingStream: (streamId: string) => MediaStream | null;
  nameOf: (participantId: string) => string;
  /**
   * When the grace period of a reconnecting presenter ends, in performance.now() time
   */
  graceDeadline: (participantId: string) => number | undefined;
}

export const ownTile = (context: TileContext): TileView => ({
  key: context.selfId ?? "self",
  name: "",
  self: true,
  stream: context.outgoing?.previewStream ?? null,
  status: context.outgoing?.hidden ? "status-self-hidden" : null,
  countdown: null,
});

const remoteTile = (context: TileContext, state: MessageRoomState, presenter: PresenterState): TileView => {
  const tile: TileView = {
    key: presenter.participantId,
    name: context.nameOf(presenter.participantId),
    self: false,
    stream: null,
    status: null,
    countdown: null,
  };

  if (presenter.status === "reconnecting") {
    const participant = state.participants.find((participant) => participant.id === presenter.participantId);
    const deadline = context.graceDeadline(presenter.participantId);

    if (participant?.connected) {
      // Back after a reload, choosing the screen again
      tile.status = "status-presenter-resuming";
    } else {
      tile.status = presenter.disconnectReason === "lost" ? "status-presenter-lost" : "status-presenter-left";
      tile.countdown = deadline == null ? null : formatCountdown(deadline - performance.now());
    }

    return tile;
  }

  // While hidden, the stream stays attached: it is black and silent
  tile.stream = context.incomingStream(presenter.streamId);

  if (presenter.hidden) {
    tile.status = "status-presenter-hidden";
  } else if (tile.stream == null) {
    tile.status = "status-joining";
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
        tiles.push(ownTile(context));
        ownTileShown = true;
      }

      continue;
    }

    tiles.push(remoteTile(context, state, presenter));
  }

  if (context.outgoing != null && !ownTileShown) {
    tiles.push(ownTile(context));
  }

  return tiles;
};

import { ActionIcon, Badge, Group, Text, Tooltip } from "@mantine/core";
import { IconMaximize, IconMicrophoneOff, IconVideo, IconVolume, IconVolumeOff } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import type { CSSProperties } from "react";
import { useCallback, useRef, useState } from "react";
import type { MessageKey } from "../i18n/index.ts";
import { t } from "../i18n/index.ts";
import { callAtom, devicesAtom, stageAtom } from "../state/atoms.ts";
import type { StatusId, TileStatusId, TileView } from "../state/views.ts";
import { useController } from "./controller.ts";
import { useFirstClick, useMediaPlayback } from "./media.ts";
import classes from "./Stage.module.css";

const TILE_STATUS: Record<TileStatusId, MessageKey> = {
  joining: "tile.joining",
  "presenter-left": "tile.left",
  "presenter-lost": "tile.lost",
  "presenter-resuming": "tile.resuming",
  "presenter-hidden": "tile.hidden",
  "self-hidden": "tile.selfHidden",
};

const PAGE_STATUS: Record<StatusId, MessageKey> = {
  connecting: "status.connecting",
  "server-reconnecting": "status.serverReconnecting",
  waiting: "status.waiting",
};

/**
 * The text over a tile: its status, with the time left of a grace period
 */
const tileStatusText = (view: TileView): string | null => {
  if (view.status == null) {
    return null;
  }

  const text = t(TILE_STATUS[view.status], { name: view.name });
  return view.countdown == null ? text : text + t("tile.countdown", { countdown: view.countdown });
};

const Tile = (props: {
  view: TileView;
  muted: boolean;
  spotlighted: boolean;
  speaker: string;
  onToggleSpotlight: () => void;
  onToggleMute: () => void;
  onBlocked: () => void;
}) => {
  const { view } = props;
  const controller = useController();
  const root = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  // The own sound never plays back, and the sound of a camera plays with the call
  const muted = view.self || view.kind === "camera" || props.muted;
  const status = tileStatusText(view);

  useMediaPlayback(video, { stream: view.stream, muted, speaker: props.speaker, onBlocked: props.onBlocked });

  return (
    <div
      ref={root}
      className={classes.tile}
      data-testid="tile"
      data-key={view.key}
      data-kind={view.kind}
      data-self={view.self || undefined}
      data-speaking={view.speaking || undefined}
      data-spotlighted={props.spotlighted || undefined}
      data-status={view.status ?? undefined}
    >
      <video
        ref={video}
        className={classes.video}
        autoPlay
        playsInline
        muted
        onResize={view.self && view.kind === "screen" ? () => controller.refreshQuality() : undefined}
      />
      {/* The whole tile enlarges it, or shows it in the grid again */}
      <button
        type="button"
        className={classes.spotlight}
        data-testid="tile-spotlight"
        aria-label={t("tile.enlarge", { name: view.self ? t("tile.self") : view.name })}
        aria-pressed={props.spotlighted}
        onClick={props.onToggleSpotlight}
      />
      {status != null && (
        <div className={classes.status} data-testid="tile-status">
          <Text>{status}</Text>
        </div>
      )}
      <div className={classes.bar}>
        <Text className={classes.name} size="sm" data-testid="tile-name">
          {view.self ? t("tile.self") : view.name}
        </Text>
        {!view.self && view.kind === "screen" && (
          <Tooltip label={muted ? t("tile.unmute") : t("tile.mute")}>
            <ActionIcon
              data-testid="tile-mute"
              variant="subtle"
              color="gray"
              aria-label={muted ? t("tile.unmute") : t("tile.mute")}
              aria-pressed={muted}
              onClick={props.onToggleMute}
            >
              {muted ? <IconVolumeOff size={18} /> : <IconVolume size={18} />}
            </ActionIcon>
          </Tooltip>
        )}
        <Tooltip label={t("tile.fullscreen")}>
          <ActionIcon
            data-testid="tile-fullscreen"
            variant="subtle"
            color="gray"
            aria-label={t("tile.fullscreen")}
            onClick={() => root.current?.requestFullscreen().catch(() => {})}
          >
            <IconMaximize size={18} />
          </ActionIcon>
        </Tooltip>
      </div>
    </div>
  );
};

/**
 * The participants in the call, over the corner of the stage
 */
const CallMembers = () => {
  const call = useAtomValue(callAtom);

  if (call.members.length === 0) {
    return null;
  }

  return (
    <Group className={classes.members} data-testid="call-members" gap={6} aria-label={t("call.members")}>
      {call.members.map((member) => (
        <Badge
          key={member.id}
          data-testid="call-member"
          data-muted={member.muted || undefined}
          data-camera={member.camera || undefined}
          data-speaking={member.speaking || undefined}
          size="lg"
          variant={member.speaking ? "filled" : "default"}
          color={member.speaking ? "green" : "gray"}
          rightSection={
            <>
              {member.camera && <IconVideo size={14} aria-label={t("call.camera")} />}
              {member.muted && <IconMicrophoneOff size={14} aria-label={t("call.muted")} />}
            </>
          }
        >
          {member.name}
        </Badge>
      ))}
    </Group>
  );
};

/**
 * The presentations and the cameras side by side. A click enlarges a tile. Tiles play with sound, unless the person
 * muted them, the own capture may carry their sound back, or the browser refused sound before the first click.
 */
export const Stage = () => {
  const stage = useAtomValue(stageAtom);
  const speaker = useAtomValue(devicesAtom).choice.speaker;
  const [spotlight, setSpotlight] = useState<string | null>(null);
  const [userMuted, setUserMuted] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  const onBlocked = useCallback(() => setAutoplayBlocked(true), []);
  const onFirstClick = useCallback(() => setAutoplayBlocked(false), []);
  useFirstClick(autoplayBlocked, onFirstClick);

  const tiles = stage.tiles;
  const spotlighted = spotlight != null && tiles.length > 1 && tiles.some((tile) => tile.key === spotlight);
  const isMuted = (key: string) => userMuted.get(key) ?? (autoplayBlocked || stage.echoMuted);
  const style = {
    "--columns": Math.ceil(Math.sqrt(tiles.length)),
    "--others": Math.max(1, tiles.length - 1),
  } as CSSProperties;

  return (
    <div
      className={classes.stage}
      data-testid="stage"
      data-count={tiles.length}
      data-many={tiles.length > 4 || undefined}
      data-spotlight={spotlighted || undefined}
      style={style}
    >
      {tiles.map((view) => (
        <Tile
          key={`${view.key}:${view.self}`}
          view={view}
          muted={isMuted(view.key)}
          spotlighted={spotlighted && view.key === spotlight}
          speaker={speaker}
          onBlocked={onBlocked}
          onToggleSpotlight={() => setSpotlight((current) => (current === view.key ? null : view.key))}
          onToggleMute={() => setUserMuted((current) => new Map(current).set(view.key, !isMuted(view.key)))}
        />
      ))}
      {stage.status != null && (
        <div className={classes.pageStatus} role="status">
          <Text size="lg" c="dimmed" data-testid="page-status" data-status={stage.status}>
            {t(PAGE_STATUS[stage.status])}
          </Text>
        </div>
      )}
      <CallMembers />
    </div>
  );
};

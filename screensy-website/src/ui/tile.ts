import type { TileKind } from "./types.ts";

export interface Tile {
  root: HTMLElement;
  video: HTMLVideoElement;
  name: HTMLElement;
  status: HTMLElement;
  mute: HTMLButtonElement;
  self: boolean;
  kind: TileKind;
}

import { getElement, setNameSlots } from "../dom.ts";
import type { Tile } from "./tile.ts";
import type { TileView } from "./types.ts";

/**
 * The presentations side by side (#stage), one tile per presenter, copied from #tile-template. Also decides which
 * tiles play sound.
 */
export class Stage {
  /**
   * The size of the own preview changed, for example when the presenter resizes the shared window
   */
  public onvideoresize: (() => void) | null = null;

  private readonly stage: HTMLElement;
  private readonly tileTemplate: HTMLTemplateElement;
  private readonly tiles = new Map<string, Tile>();

  /**
   * The presenter whose tile is enlarged, by participant ID
   */
  private spotlightKey: string | null = null;

  /**
   * The sound setting chosen for each presenter. Tiles without one follow the automatic muting.
   */
  private readonly userMuted = new Map<string, boolean>();

  /**
   * The browser did not allow playing sound before the first click on the page
   */
  private autoplayBlocked = false;

  /**
   * This presenter's capture may contain this page's sound, so the other presenters are muted
   */
  private echoMuted = false;

  private readonly selfTileText: string;
  private readonly muteText: string;
  private readonly unmuteText: string;

  constructor() {
    this.stage = getElement("stage", HTMLElement);
    this.tileTemplate = getElement("tile-template", HTMLTemplateElement);
    this.selfTileText = getElement("text-self-tile", HTMLElement).textContent.trim();
    this.muteText = getElement("text-mute", HTMLElement).textContent.trim();
    this.unmuteText = getElement("text-unmute", HTMLElement).textContent.trim();

    // The first click on the page allows playing sound
    document.addEventListener(
      "click",
      () => {
        if (this.autoplayBlocked) {
          this.autoplayBlocked = false;
          this.refreshAudio();
        }
      },
      { capture: true },
    );
  }

  /**
   * Shows the presentations side by side, in the given order
   */
  showTiles(views: TileView[]): void {
    const keys = new Set(views.map((view) => view.key));

    for (const [key, tile] of this.tiles) {
      if (!keys.has(key)) {
        tile.video.srcObject = null;
        tile.root.remove();
        this.tiles.delete(key);
      }
    }

    if (this.spotlightKey != null && !keys.has(this.spotlightKey)) {
      this.spotlightKey = null;
    }

    const roots = views.map((view) => {
      let tile = this.tiles.get(view.key);

      if (tile == null || tile.self !== view.self) {
        tile?.root.remove();
        tile = this.createTile(view.key, view.self);
        this.tiles.set(view.key, tile);
      }

      tile.name.textContent = view.self ? this.selfTileText : view.name;

      if (tile.video.srcObject !== view.stream) {
        tile.video.srcObject = view.stream;
      }

      this.showTileStatus(tile, view);
      return tile.root;
    });

    // Only move tiles when the order changed, because moving a video pauses it
    const current = [...this.stage.children];

    if (current.length !== roots.length || roots.some((root, index) => current[index] !== root)) {
      this.stage.replaceChildren(...roots);
    }

    this.stage.dataset.count = roots.length.toString();
    this.updateLayout();
    this.refreshAudio();
  }

  /**
   * Mutes the other presenters, or lets them follow their sound setting again
   */
  setEchoMuted(muted: boolean): void {
    if (this.echoMuted !== muted) {
      this.echoMuted = muted;
      this.refreshAudio();
    }
  }

  private createTile(key: string, self: boolean): Tile {
    const fragment = this.tileTemplate.content.cloneNode(true) as DocumentFragment;
    const find = <T extends Element>(selector: string, type: { new (): T; prototype: T }): T => {
      const element = fragment.querySelector(selector);

      if (!(element instanceof type)) {
        throw new Error(`The tile template has no ${selector}.`);
      }

      return element;
    };

    const tile: Tile = {
      root: find(".tile", HTMLElement),
      video: find("video", HTMLVideoElement),
      name: find(".tile-name", HTMLElement),
      status: find(".tile-status", HTMLElement),
      mute: find(".tile-mute", HTMLButtonElement),
      self,
    };

    tile.root.dataset.key = key;
    tile.root.toggleAttribute("data-self", self);
    tile.video.muted = true;
    // Never play back the presenter's own sound
    tile.mute.classList.toggle("hidden", self);

    // Playback stops when the tile moves, or when the browser refuses the sound
    tile.video.addEventListener("pause", () => this.play(tile));

    if (self) {
      tile.video.addEventListener("resize", () => this.onvideoresize?.());
    }

    tile.root.addEventListener("click", () => {
      this.spotlightKey = this.spotlightKey === key ? null : key;
      this.updateLayout();
    });

    tile.mute.addEventListener("click", (event: MouseEvent) => {
      event.stopPropagation();
      this.userMuted.set(key, !this.isMuted(key));
      this.refreshAudio();
    });

    find(".tile-fullscreen", HTMLButtonElement).addEventListener("click", (event: MouseEvent) => {
      event.stopPropagation();
      tile.root.requestFullscreen().catch(() => {});
    });

    return tile;
  }

  private showTileStatus(tile: Tile, view: TileView): void {
    tile.status.classList.toggle("hidden", view.status == null);

    for (const element of tile.status.querySelectorAll<HTMLElement>("[data-status]")) {
      const shown = element.dataset.status === view.status;
      element.classList.toggle("hidden", !shown);

      if (shown) {
        setNameSlots(element, view.name);

        for (const countdownElement of element.querySelectorAll(".countdown")) {
          countdownElement.classList.toggle("hidden", view.countdown == null);
        }

        for (const slot of element.querySelectorAll(".countdown-slot")) {
          slot.textContent = view.countdown ?? "";
        }
      }
    }
  }

  /**
   * Lays the tiles out evenly, or enlarges one of them and puts the others in a column
   */
  private updateLayout(): void {
    const spotlight = this.spotlightKey != null && this.tiles.size > 1;
    this.stage.classList.toggle("spotlight", spotlight);
    this.stage.style.setProperty("--others", Math.max(1, this.tiles.size - 1).toString());

    for (const [key, tile] of this.tiles) {
      tile.root.classList.toggle("spotlighted", spotlight && key === this.spotlightKey);
    }
  }

  private isMuted(key: string): boolean {
    return this.userMuted.get(key) ?? (this.autoplayBlocked || this.echoMuted);
  }

  private refreshAudio(): void {
    for (const [key, tile] of this.tiles) {
      const muted = tile.self || this.isMuted(key);
      tile.video.muted = muted;
      tile.mute.textContent = muted ? "🔇" : "🔊";
      tile.mute.setAttribute("aria-label", muted ? this.unmuteText : this.muteText);
      tile.mute.setAttribute("aria-pressed", muted.toString());
      this.play(tile);
    }
  }

  /**
   * Plays a tile. If the browser refuses the sound before the first click, every tile without its own sound setting
   * plays muted until then.
   */
  private play(tile: Tile): void {
    if (tile.video.srcObject == null || !tile.video.paused) {
      return;
    }

    tile.video.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "NotAllowedError" && !tile.video.muted) {
        this.autoplayBlocked = true;
        this.refreshAudio();
      }
    });
  }
}

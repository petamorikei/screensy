import { getElement } from "../dom.ts";

export interface CallAudioView {
  /**
   * The stream ID, so that an element keeps playing while its stream stays
   */
  key: string;
  stream: MediaStream;
}

/**
 * Plays the voice call: one <audio> per received stream, in the hidden #call-audio
 */
export class CallAudio {
  /**
   * The browser did not allow playing sound before a click on the page. Called once per refusal.
   */
  public onblocked: (() => void) | null = null;

  private readonly container: HTMLElement;
  private readonly elements = new Map<string, HTMLAudioElement>();
  private muted = false;
  private blocked = false;

  constructor() {
    this.container = getElement("call-audio", HTMLElement);

    // A click on the page allows playing sound
    document.addEventListener(
      "click",
      () => {
        if (this.blocked) {
          this.blocked = false;

          for (const audio of this.elements.values()) {
            this.play(audio);
          }
        }
      },
      { capture: true },
    );
  }

  show(views: CallAudioView[]): void {
    const keys = new Set(views.map((view) => view.key));

    for (const [key, audio] of this.elements) {
      if (!keys.has(key)) {
        audio.srcObject = null;
        audio.remove();
        this.elements.delete(key);
      }
    }

    for (const view of views) {
      let audio = this.elements.get(view.key);

      if (audio == null) {
        audio = document.createElement("audio");
        audio.dataset.streamId = view.key;
        audio.muted = this.muted;
        this.container.append(audio);
        this.elements.set(view.key, audio);
      }

      if (audio.srcObject !== view.stream) {
        audio.srcObject = view.stream;
      }

      this.play(audio);
    }
  }

  /**
   * Mutes the whole call on this page, or plays it again
   */
  setMuted(muted: boolean): void {
    this.muted = muted;

    for (const audio of this.elements.values()) {
      audio.muted = muted;
    }
  }

  private play(audio: HTMLAudioElement): void {
    if (!audio.paused || this.blocked) {
      return;
    }

    audio.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "NotAllowedError" && !this.blocked) {
        this.blocked = true;
        this.onblocked?.();
      }
    });
  }
}

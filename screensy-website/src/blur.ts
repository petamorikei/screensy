import * as z from "zod";
import { getLocalStorage, readStorage } from "./storage.ts";

/**
 * Whether this browser can blur the screen
 */
export const isBlurSupported = (): boolean => {
  return "MediaStreamTrackProcessor" in window && "MediaStreamTrackGenerator" in window && "OffscreenCanvas" in window;
};

/**
 * The strength of the blur: how many CSS pixels on screen, in each direction, become one pixel. The presenter chooses
 * it with a slider. The minimum is the size of a pixel of the blurred video (BLUR_OUTPUT_CSS_PX), the lightest blur
 * that it can show, which still lets large text be read; 16 already hides body text; 64 leaves little more than the
 * layout.
 */
export const BLUR_MIN_STRENGTH = 4;
export const BLUR_MAX_STRENGTH = 64;
export const BLUR_DEFAULT_STRENGTH = 24;
export const BLUR_STORAGE_KEY = "screensy.blur";

/**
 * Each pixel of the blurred video covers this many CSS pixels on screen in each direction, whatever the strength, so
 * that moving the slider never changes the size of the sent video (a new size makes the encoder start over)
 */
export const BLUR_OUTPUT_CSS_PX = 4;

export const BlurStrengthSchema = z.int().min(BLUR_MIN_STRENGTH).max(BLUR_MAX_STRENGTH);

/**
 * The strength saved in localStorage, or the default
 */
export const readBlurStrength = (): number =>
  z.coerce
    .number()
    .pipe(BlurStrengthSchema)
    .catch(BLUR_DEFAULT_STRENGTH)
    .parse(readStorage(getLocalStorage, BLUR_STORAGE_KEY));

/**
 * Turns a video track into a blurred one: text cannot be read, but the layout and movement can be seen.
 *
 * Each frame is shrunk by halves, so that every step averages its pixels (a single large step in a canvas only picks
 * some pixels, which leaves sharp fragments), down to one pixel per strength × devicePixelRatio device pixels. The
 * density makes the same strength look the same on a Retina screen, assuming that the shared screen has the density of
 * the screen of this window. The result is scaled up to the fixed output size and smoothed with a blur that grows
 * with the scale.
 */
export class BlurProcessor {
  /**
   * The blurred video
   */
  readonly track: MediaStreamTrack;

  private strength: number;
  private readonly abort = new AbortController();

  /**
   * The canvases of the halving steps, reused from frame to frame
   */
  private readonly halves: OffscreenCanvas[] = [];

  constructor(source: MediaStreamTrack, strength: number) {
    const processor = new MediaStreamTrackProcessor({ track: source });
    const generator = new MediaStreamTrackGenerator({ kind: "video" });
    const sample = new OffscreenCanvas(2, 2);
    const output = new OffscreenCanvas(2, 2);
    const sampleContext = sample.getContext("2d");
    const outputContext = output.getContext("2d");

    if (sampleContext == null || outputContext == null) {
      throw new Error("No 2D canvas for the blur.");
    }

    this.track = generator;
    this.strength = strength;

    const blur = new TransformStream<VideoFrame, VideoFrame>({
      transform: (frame, controller) => {
        try {
          // Zooming the page out must not weaken the blur below that of a plain screen
          const density = Math.max(window.devicePixelRatio || 1, 1);
          const width = frame.displayWidth;
          const height = frame.displayHeight;
          resizeCanvas(sample, width / (this.strength * density), height / (this.strength * density));
          resizeCanvas(output, width / (BLUR_OUTPUT_CSS_PX * density), height / (BLUR_OUTPUT_CSS_PX * density));

          const shrunk = this.shrink(frame, width, height, sample.width);
          sampleContext.imageSmoothingEnabled = true;
          sampleContext.imageSmoothingQuality = "high";
          sampleContext.drawImage(shrunk, 0, 0, sample.width, sample.height);

          // About two thirds of a sample pixel, so that the scaled-up pixels melt together. The frame is drawn larger
          // on each side, so that the blur does not darken the edges.
          const smoothing = ((output.width / sample.width) * 2) / 3;
          const margin = smoothing * 2;
          outputContext.imageSmoothingEnabled = true;
          outputContext.imageSmoothingQuality = "high";
          outputContext.filter = `blur(${smoothing}px)`;
          outputContext.drawImage(sample, -margin, -margin, output.width + margin * 2, output.height + margin * 2);

          controller.enqueue(new VideoFrame(output, { timestamp: frame.timestamp }));
        } finally {
          frame.close();
        }
      },
    });

    // Ends by itself when the capture ends
    processor.readable
      .pipeThrough(blur, { signal: this.abort.signal })
      .pipeTo(generator.writable, { signal: this.abort.signal })
      .catch(() => {});
  }

  /**
   * Takes effect from the next frame
   */
  setStrength(strength: number): void {
    this.strength = strength;
  }

  stop(): void {
    this.abort.abort();
    this.track.stop();
  }

  /**
   * Halves the frame until the next half would be smaller than the target width
   */
  private shrink(frame: VideoFrame, width: number, height: number, targetWidth: number): CanvasImageSource {
    let current: CanvasImageSource = frame;
    let currentWidth = width;
    let currentHeight = height;
    let step = 0;

    while (currentWidth / 2 >= targetWidth) {
      currentWidth = Math.max(2, Math.round(currentWidth / 2));
      currentHeight = Math.max(2, Math.round(currentHeight / 2));

      this.halves[step] ??= new OffscreenCanvas(2, 2);
      const half = this.halves[step];
      resizeCanvas(half, currentWidth, currentHeight);

      const context = half.getContext("2d");

      if (context == null) {
        break;
      }

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(current, 0, 0, currentWidth, currentHeight);
      current = half;
      step++;
    }

    return current;
  }
}

/**
 * Resizes a canvas to whole pixels, at least 2 by 2, only when the size changes (resizing clears it)
 */
export const resizeCanvas = (canvas: OffscreenCanvas, width: number, height: number): void => {
  const newWidth = Math.max(2, Math.round(width));
  const newHeight = Math.max(2, Math.round(height));

  if (canvas.width !== newWidth || canvas.height !== newHeight) {
    canvas.width = newWidth;
    canvas.height = newHeight;
  }
};

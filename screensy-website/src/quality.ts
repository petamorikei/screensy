import * as z from "zod";
import { getLocalStorage, readStorage, writeStorage } from "./storage.ts";

export const QUALITY_STORAGE_KEY = "screensy.quality";

/**
 * The frame rates to choose from
 */
export const FRAME_RATES = [60, 30];
export const MIN_BITRATE_MBPS = 0.1;
export const MAX_BITRATE_MBPS = 100;
export const AUDIO_BITRATE = 960_000;

/**
 * The resolutions to choose from, as the maximum height. null keeps the resolution of the capture.
 */
export const RESOLUTION_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];

// Each setting on its own, also for the inputs of the menu
export const FrameRateSchema = z.number().refine((value) => FRAME_RATES.includes(value));
export const MaxHeightSchema = z
  .number()
  .refine((value) => RESOLUTION_HEIGHTS.includes(value))
  .nullable();
export const BitrateSchema = z.number().min(MIN_BITRATE_MBPS).max(MAX_BITRATE_MBPS);
export const DegradationSchema = z.enum(["maintain-resolution", "maintain-framerate", "balanced"]);

/**
 * How the presenter's screen is encoded. The menu changes it, and localStorage remembers it. Each invalid or missing
 * value falls back to its default.
 */
const QualitySettingsSchema = z.object({
  frameRate: FrameRateSchema.catch(30),
  maxHeight: MaxHeightSchema.catch(null),
  maxBitrateMbps: BitrateSchema.catch(100),
  /**
   * What to keep when the bandwidth is short: the resolution, the frame rate, or a balance
   */
  degradation: DegradationSchema.catch("maintain-resolution"),
});

export type QualitySettings = z.infer<typeof QualitySettingsSchema>;

export const DEFAULT_QUALITY: QualitySettings = QualitySettingsSchema.parse({});

/**
 * The defaults of the fields only apply inside an object, so anything else that is stored (nothing, an array, a
 * number) counts as an empty object
 */
const StoredQualitySchema = z.preprocess(
  (value) => (typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}),
  QualitySettingsSchema,
);

/**
 * Reads the quality settings from localStorage. Each invalid or missing value falls back to its default.
 */
export const readQuality = (): QualitySettings => {
  let stored: unknown;

  try {
    stored = JSON.parse(readStorage(getLocalStorage, QUALITY_STORAGE_KEY) ?? "null");
  } catch {
    stored = null;
  }

  return StoredQualitySchema.parse(stored);
};

export const writeQuality = (quality: QualitySettings): void => {
  writeStorage(getLocalStorage, QUALITY_STORAGE_KEY, JSON.stringify(quality));
};

/**
 * The options for getDisplayMedia. The capture must deliver at least the frame rate that is sent.
 */
export const displayMediaOptions = (quality: QualitySettings): DisplayMediaStreamOptions => {
  // Neither option is in lib.dom yet. Browsers that do not know them ignore them.
  const audio: MediaTrackConstraints & { restrictOwnAudio?: boolean } = {
    channelCount: { ideal: 2 },
    sampleRate: { ideal: 192000 },
    noiseSuppression: { ideal: false },
    echoCancellation: { ideal: false },
    autoGainControl: { ideal: false },
    // Keep the other presenters' sound, which this page plays, out of a system audio capture
    restrictOwnAudio: true,
  };
  const options: DisplayMediaStreamOptions & { selfBrowserSurface?: "include" | "exclude" } = {
    video: { frameRate: { ideal: quality.frameRate } },
    audio,
    // This tab plays the other presenters' sound
    selfBrowserSurface: "exclude",
  };

  return options;
};

/**
 * The content hint of the video track, which steers the encoder like the degradation preference
 */
export const contentHintFor = (degradation: RTCDegradationPreference): string => {
  switch (degradation) {
    case "maintain-resolution":
      return "detail";
    case "maintain-framerate":
      return "motion";
    default:
      return "";
  }
};

/**
 * Applies the quality settings to the senders of a connection. The resolution limit is a scale factor, computed from
 * the current height of the capture, so it has to be applied again when the captured window is resized.
 */
export const applyQuality = async (connection: RTCPeerConnection, quality: QualitySettings): Promise<void> => {
  for (const sender of connection.getSenders()) {
    const track = sender.track;

    if (track == null) {
      continue;
    }

    const parameters = sender.getParameters();

    // https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters#currently_compatible_implementation
    if (!parameters.encodings || parameters.encodings.length === 0) {
      parameters.encodings = [{}];
    }

    const encoding = parameters.encodings[0];

    if (track.kind === "audio") {
      encoding.maxBitrate = AUDIO_BITRATE;
    } else if (track.kind === "video") {
      const height = track.getSettings().height;

      encoding.maxFramerate = quality.frameRate;
      encoding.maxBitrate = Math.round(quality.maxBitrateMbps * 1_000_000);
      encoding.scaleResolutionDownBy =
        quality.maxHeight != null && height != null && height > quality.maxHeight ? height / quality.maxHeight : 1;
      parameters.degradationPreference = quality.degradation;
    }

    try {
      await sender.setParameters(parameters);
    } catch (error) {
      console.warn("Could not set the encoding parameters.", error);
    }
  }
};

import { BlurProcessor } from "./blur.ts";

/**
 * Whether a capture may contain the sound that this page plays. With system audio, it would send the other
 * presenters' sound back to them, and two such presenters would echo forever. restrictOwnAudio removes this page's
 * sound where the browser supports it. A tab capture only has that tab's sound, and this tab cannot be chosen.
 */
export const capturesOwnAudio = (stream: MediaStream): boolean => {
  const audio = stream.getAudioTracks()[0];

  if (audio == null) {
    return false;
  }

  const settings: MediaTrackSettings & { restrictOwnAudio?: boolean } = audio.getSettings();

  if (settings.restrictOwnAudio === true) {
    return false;
  }

  // The surface is that of the video; a window capture can still carry system audio
  return stream.getVideoTracks()[0]?.getSettings().displaySurface !== "browser";
};

/**
 * A screen capture and the tracks sent from it. The preview shows what is sent, so that the presenter sees exactly
 * what the viewers get, including the black screen while hidden and the blur.
 */
export interface Capture {
  stream: MediaStream;
  video: MediaStreamTrack | null;
  audio: MediaStreamTrack | null;
  /**
   * Blurs the video while the presenter wants it blurred
   */
  blur: BlurProcessor | null;
  /**
   * The capture itself, or a stream of the blurred video
   */
  preview: MediaStream;
}

/**
 * @param blurStrength The strength of the blur, or null to send the capture sharp
 */
export const prepareCapture = (stream: MediaStream, hidden: boolean, blurStrength: number | null): Capture => {
  const video = stream.getVideoTracks()[0] ?? null;
  const blur = blurStrength != null && video != null ? new BlurProcessor(video, blurStrength) : null;
  const capture: Capture = {
    stream,
    video,
    audio: stream.getAudioTracks()[0] ?? null,
    blur,
    preview: blur == null ? stream : new MediaStream([blur.track]),
  };

  // Before the tracks reach any sender, so that a hidden presentation never leaks a frame
  setCaptureHidden(capture, hidden);

  return capture;
};

/**
 * The video track that the senders get: the blurred one while blurred
 */
export const sentVideo = (capture: Capture): MediaStreamTrack | null => {
  return capture.blur?.track ?? capture.video;
};

/**
 * Hiding disables every track, including the input of the blur, so that turning the blur on or off while hidden
 * never shows the screen.
 */
export const setCaptureHidden = (capture: Capture, hidden: boolean): void => {
  for (const track of [capture.video, capture.blur?.track, capture.audio]) {
    if (track != null) {
      track.enabled = !hidden;
    }
  }
};

export const stopCapture = (capture: Capture): void => {
  capture.blur?.stop();

  for (const track of capture.stream.getTracks()) {
    track.stop();
  }
};

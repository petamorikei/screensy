/**
 * @source  ./screensy.ts
 *
 * @licstart  The following is the entire license notice for the JavaScript
 * code in this page.
 *
 * Copyright (C) 2021  Stef Gijsberts, Marijn van Wezel
 *
 * The JavaScript code in this page is free software: you can redistribute it
 * and/or modify it under the terms of the GNU General Public License (GNU GPL)
 * as published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.  The code is distributed
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU GPL for more details.
 *
 * As additional permission under GNU GPL version 3 section 7, you may
 * distribute non-source (e.g., minimized or compacted) forms of that code
 * without the copy of the GNU GPL normally required by section 4, provided you
 * include this license notice and a URL through which recipients can access
 * the Corresponding Source.
 *
 * @licend  The above is the entire license notice for the JavaScript code in
 * this page.
 */

// The signaling protocol. These types are duplicated in screensy-rendezvous/server.ts.

/**
 * The WebRTC payload of a signal, discriminated by its kind
 */
type WebRTCPayload =
  | { kind: "offer" | "answer"; message: RTCSessionDescriptionInit }
  | { kind: "candidate"; message: RTCIceCandidateInit };

// Messages from the client to the server

/**
 * Joins a room. A resume token from an earlier "welcome" takes over that participant.
 */
interface MessageJoin {
  type: "join";
  roomId: string;
  name: string;
  resumeToken?: string;
}

interface MessageSetName {
  type: "setname";
  name: string;
}

/**
 * Starts presenting, after the screen has been captured. With resume, the server only accepts it when this client
 * still holds a presenter seat.
 */
interface MessagePresent {
  type: "present";
  resume: boolean;
  /**
   * The presenter to take over when the room has reached MAX_PRESENTERS. Ignored below the limit.
   */
  replace?: string;
}

interface MessageStopPresenting {
  type: "stoppresenting";
}

interface MessageStreamState {
  type: "streamstate";
  streamId: string;
  hidden: boolean;
}

/**
 * Sends a WebRTC message to another participant through the server
 */
type MessageSignalToServer = { type: "signal"; to: string; toConnection: string; streamId: string } & WebRTCPayload;

type ClientMessage =
  | MessageJoin
  | MessageSetName
  | MessagePresent
  | MessageStopPresenting
  | MessageStreamState
  | MessageSignalToServer;

// Messages from the server to the client

interface MessageWelcome {
  type: "welcome";
  selfId: string;
  connectionId: string;
  resumeToken: string;
  /**
   * The number of people that can present at the same time
   */
  maxPresenters: number;
}

interface ParticipantState {
  id: string;
  connectionId: string;
  name: string;
  connected: boolean;
}

/**
 * Why a presenter seat is reconnecting: "left" if the page closed its socket (a reload or a closed tab), "lost" if the
 * connection broke.
 */
type DisconnectReason = "left" | "lost";

interface PresenterState {
  participantId: string;
  streamId: string;
  hidden: boolean;
  status: "live" | "reconnecting";
  /**
   * Null while the seat is live
   */
  disconnectReason: DisconnectReason | null;
  /**
   * The time left before the seat is freed, or null if no grace period runs
   */
  graceRemainingMs: number | null;
}

interface MessageRoomState {
  type: "roomstate";
  participants: ParticipantState[];
  presenters: PresenterState[];
}

/**
 * A WebRTC message from another participant. The server sets "from" and "fromConnection".
 */
type MessageSignalFromServer = {
  type: "signal";
  from: string;
  fromConnection: string;
  streamId: string;
} & WebRTCPayload;

interface MessagePresentAccepted {
  type: "presentaccepted";
  streamId: string;
}

interface MessagePresentRejected {
  type: "presentrejected";
  /**
   * "seat-lost": a resume, but the seat is gone. "full": the room has reached MAX_PRESENTERS, and "replace" does not
   * name one of the presenters.
   */
  reason: "seat-lost" | "full";
}

/**
 * Another socket has joined with this client's resume token, for example from a duplicated tab.
 */
interface MessageReplaced {
  type: "replaced";
}

type ServerMessage =
  | MessageWelcome
  | MessageRoomState
  | MessageSignalFromServer
  | MessagePresentAccepted
  | MessagePresentRejected
  | MessageReplaced;

type MessageSender = (message: ClientMessage) => void;

const NAME_STORAGE_KEY = "screensy.name";
const RESUME_STORAGE_PREFIX = "screensy.resume.";
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];
const NOTICE_TIMEOUT_MS = 10000;
const COPY_FEEDBACK_MS = 2000;
const STATS_INTERVAL_MS = 1000;

/**
 * Shown for a value that the browser does not report
 */
const NO_VALUE = "—";

const QUALITY_STORAGE_KEY = "screensy.quality";

/**
 * The frame rates to choose from
 */
const FRAME_RATES = [60, 30];
const MIN_BITRATE_MBPS = 0.1;
const MAX_BITRATE_MBPS = 100;
const AUDIO_BITRATE = 960_000;

/**
 * The resolutions to choose from, as the maximum height. null keeps the resolution of the capture.
 */
const RESOLUTION_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];

/**
 * How the presenter's screen is encoded. The menu changes it, and localStorage remembers it.
 */
interface QualitySettings {
  frameRate: number;
  maxHeight: number | null;
  maxBitrateMbps: number;
  /**
   * What to keep when the bandwidth is short: the resolution, the frame rate, or a balance
   */
  degradation: RTCDegradationPreference;
}

const DEFAULT_QUALITY: QualitySettings = {
  frameRate: 30,
  maxHeight: null,
  maxBitrateMbps: 100,
  degradation: "maintain-resolution",
};

/**
 * What the whole page shows over the stage
 */
type StatusId = "status-connecting" | "status-server-reconnecting" | "status-waiting";

const STATUS_IDS: StatusId[] = ["status-connecting", "status-server-reconnecting", "status-waiting"];

/**
 * What a tile shows over its presentation. The values are the data-status attributes in #tile-template.
 */
type TileStatusId =
  | "status-joining"
  | "status-presenter-left"
  | "status-presenter-lost"
  | "status-presenter-resuming"
  | "status-presenter-hidden"
  | "status-self-hidden";

/**
 * One presentation on the stage
 */
interface TileView {
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

interface Tile {
  root: HTMLElement;
  video: HTMLVideoElement;
  name: HTMLElement;
  status: HTMLElement;
  mute: HTMLButtonElement;
  self: boolean;
}

/**
 * Whether a capture may contain the sound that this page plays. With system audio, it would send the other
 * presenters' sound back to them, and two such presenters would echo forever. restrictOwnAudio removes this page's
 * sound where the browser supports it. A tab capture only has that tab's sound, and this tab cannot be chosen.
 */
function capturesOwnAudio(stream: MediaStream): boolean {
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
}

type NoticeId =
  | "notice-taken-over"
  | "notice-moved-to-other-tab"
  | "notice-connection-lost"
  | "notice-access-denied"
  | "notice-switch-failed"
  | "notice-blur-failed"
  | "notice-full"
  | "notice-echo-muted";

type DialogMode = "start" | "resume";

/**
 * Displays the popup with the given name. Does nothing if the popup does not
 * exist.
 *
 * @param name Name of the popup to display
 */
function showPopup(name: string): void {
  document.getElementById(name)?.classList.remove("hidden");
}

/**
 * Hides the popup with the given name. Does nothing if the popup is not visible or if
 * the popup does not exist.
 *
 * @param name Name of the popup to hide
 */
function hidePopup(name: string): void {
  document.getElementById(name)?.classList.add("hidden");
}

/**
 * Returns the element with the given ID, or throws if it is missing or has the wrong type. Every translation file
 * must contain the same elements.
 */
function getElement<T extends HTMLElement>(id: string, type: { new (): T; prototype: T }): T {
  const element = document.getElementById(id);

  if (!(element instanceof type)) {
    throw new Error(`The element #${id} is missing.`);
  }

  return element;
}

/**
 * Fills every ".name-slot" inside the element with the given name.
 */
function setNameSlots(element: Element, name: string): void {
  for (const slot of element.querySelectorAll(".name-slot")) {
    slot.textContent = name;
  }
}

function formatBitrate(bitsPerSecond: number | null): string {
  if (bitsPerSecond == null) {
    return NO_VALUE;
  }

  return bitsPerSecond >= 1_000_000
    ? `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`
    : `${Math.round(bitsPerSecond / 1000)} kbps`;
}

/**
 * Formats a duration as "m:ss", rounded up, so that "0:00" only shows when the time is up.
 */
function formatCountdown(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Reads a value from Web Storage. Storage can be unavailable, for example in a private window.
 */
function readStorage(getStorage: () => Storage, key: string): string | null {
  try {
    return getStorage().getItem(key);
  } catch {
    return null;
  }
}

/**
 * Writes a value to Web Storage, or removes it if the value is null.
 */
function writeStorage(getStorage: () => Storage, key: string, value: string | null): void {
  try {
    if (value == null) {
      getStorage().removeItem(key);
    } else {
      getStorage().setItem(key, value);
    }
  } catch {
    // Storage is unavailable. The value is simply not remembered.
  }
}

const getLocalStorage = () => window.localStorage;
const getSessionStorage = () => window.sessionStorage;

/**
 * Reads the quality settings from localStorage. Each invalid or missing value falls back to its default.
 */
function readQuality(): QualitySettings {
  let stored: unknown;

  try {
    stored = JSON.parse(readStorage(getLocalStorage, QUALITY_STORAGE_KEY) ?? "null");
  } catch {
    stored = null;
  }

  const values = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};

  return {
    frameRate: isValidFrameRate(values.frameRate) ? values.frameRate : DEFAULT_QUALITY.frameRate,
    maxHeight: isValidMaxHeight(values.maxHeight) ? values.maxHeight : DEFAULT_QUALITY.maxHeight,
    maxBitrateMbps: isValidBitrate(values.maxBitrateMbps) ? values.maxBitrateMbps : DEFAULT_QUALITY.maxBitrateMbps,
    degradation: isValidDegradation(values.degradation) ? values.degradation : DEFAULT_QUALITY.degradation,
  };
}

function writeQuality(quality: QualitySettings): void {
  writeStorage(getLocalStorage, QUALITY_STORAGE_KEY, JSON.stringify(quality));
}

function isValidFrameRate(value: unknown): value is number {
  return FRAME_RATES.includes(value as number);
}

function isValidMaxHeight(value: unknown): value is number | null {
  return value === null || RESOLUTION_HEIGHTS.includes(value as number);
}

function isValidBitrate(value: unknown): value is number {
  return typeof value === "number" && value >= MIN_BITRATE_MBPS && value <= MAX_BITRATE_MBPS;
}

function isValidDegradation(value: unknown): value is RTCDegradationPreference {
  return value === "maintain-resolution" || value === "maintain-framerate" || value === "balanced";
}

/**
 * The options for getDisplayMedia. The capture must deliver at least the frame rate that is sent.
 */
function displayMediaOptions(quality: QualitySettings): DisplayMediaStreamOptions {
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
}

/**
 * The content hint of the video track, which steers the encoder like the degradation preference
 */
function contentHintFor(degradation: RTCDegradationPreference): string {
  switch (degradation) {
    case "maintain-resolution":
      return "detail";
    case "maintain-framerate":
      return "motion";
    default:
      return "";
  }
}

/**
 * Applies the quality settings to the senders of a connection. The resolution limit is a scale factor, computed from
 * the current height of the capture, so it has to be applied again when the captured window is resized.
 */
async function applyQuality(connection: RTCPeerConnection, quality: QualitySettings): Promise<void> {
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
}

/**
 * Connects to the signaling server and reconnects when the connection is lost.
 */
class SignalingConnection {
  public onopen: (() => void) | null = null;
  public onclose: (() => void) | null = null;
  public onmessage: ((message: ServerMessage) => void) | null = null;

  private readonly url: string;
  private socket: WebSocket | null = null;
  private attempt = 0;
  private closed = false;
  private hasConnected = false;

  constructor(url: string) {
    this.url = url;
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Whether the connection has been open at least once
   */
  get everConnected(): boolean {
    return this.hasConnected;
  }

  connect(): void {
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.hasConnected = true;
      hidePopup("websocket-connect-failed");
      this.onopen?.();
    };

    socket.onerror = () => {
      if (!this.hasConnected) {
        showPopup("websocket-connect-failed");
      }
    };

    socket.onmessage = (event: MessageEvent) => {
      let message: unknown;

      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (typeof message === "object" && message !== null && "type" in message) {
        this.onmessage?.(message as ServerMessage);
      }
    };

    socket.onclose = () => {
      if (this.socket !== socket) {
        return;
      }

      this.socket = null;
      this.onclose?.();

      if (!this.closed) {
        const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)];
        this.attempt++;
        setTimeout(() => this.connect(), delay);
      }
    };
  }

  /**
   * Sends a message. Messages are dropped while disconnected, because the client resynchronizes from the next
   * "roomstate" after it reconnects.
   */
  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
  }
}

/**
 * Wraps an RTCPeerConnection and holds back ICE candidates until the remote description is set.
 */
class PeerLink {
  public readonly connection: RTCPeerConnection;

  private pendingCandidates: RTCIceCandidateInit[] = [];
  private hasRemoteDescription = false;

  constructor(rtcConfig: RTCConfiguration) {
    this.connection = new RTCPeerConnection(rtcConfig);
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.connection.setRemoteDescription(description);
    this.hasRemoteDescription = true;

    const candidates = this.pendingCandidates;
    this.pendingCandidates = [];

    for (const candidate of candidates) {
      await this.connection.addIceCandidate(candidate);
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.hasRemoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }

    await this.connection.addIceCandidate(candidate);
  }

  close(): void {
    this.connection.close();
  }
}

interface OutgoingPeer {
  connectionId: string;
  link: PeerLink;
  videoSender: RTCRtpSender;
  audioSender: RTCRtpSender;
  /**
   * The last setParameters of this connection. They run one after the other, because each one needs the parameters
   * that the previous one set.
   */
  applyingQuality: Promise<void>;
}

// The "breakout box" of Chrome and Edge, which lib.dom does not declare yet. Its streams keep running when the tab is
// in the background, unlike requestAnimationFrame and timers.
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack });
  readonly readable: ReadableStream<VideoFrame>;
}

declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: "video" });
  readonly writable: WritableStream<VideoFrame>;
}

/**
 * Whether this browser can blur the screen
 */
function isBlurSupported(): boolean {
  return "MediaStreamTrackProcessor" in window && "MediaStreamTrackGenerator" in window && "OffscreenCanvas" in window;
}

/**
 * The strength of the blur: how many CSS pixels on screen, in each direction, become one pixel. The presenter chooses
 * it with a slider. The minimum is the size of a pixel of the blurred video (BLUR_OUTPUT_CSS_PX), the lightest blur
 * that it can show, which still lets large text be read; 16 already hides body text; 64 leaves little more than the
 * layout.
 */
const BLUR_MIN_STRENGTH = 4;
const BLUR_MAX_STRENGTH = 64;
const BLUR_DEFAULT_STRENGTH = 24;
const BLUR_STORAGE_KEY = "screensy.blur";

/**
 * Each pixel of the blurred video covers this many CSS pixels on screen in each direction, whatever the strength, so
 * that moving the slider never changes the size of the sent video (a new size makes the encoder start over)
 */
const BLUR_OUTPUT_CSS_PX = 4;

function isValidBlurStrength(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= BLUR_MIN_STRENGTH && (value as number) <= BLUR_MAX_STRENGTH;
}

function readBlurStrength(): number {
  const stored = Number(readStorage(getLocalStorage, BLUR_STORAGE_KEY));
  return isValidBlurStrength(stored) ? stored : BLUR_DEFAULT_STRENGTH;
}

/**
 * Turns a video track into a blurred one: text cannot be read, but the layout and movement can be seen.
 *
 * Each frame is shrunk by halves, so that every step averages its pixels (a single large step in a canvas only picks
 * some pixels, which leaves sharp fragments), down to one pixel per strength × devicePixelRatio device pixels. The
 * density makes the same strength look the same on a Retina screen, assuming that the shared screen has the density of
 * the screen of this window. The result is scaled up to the fixed output size and smoothed with a blur that grows
 * with the scale.
 */
class BlurProcessor {
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
function resizeCanvas(canvas: OffscreenCanvas, width: number, height: number): void {
  const newWidth = Math.max(2, Math.round(width));
  const newHeight = Math.max(2, Math.round(height));

  if (canvas.width !== newWidth || canvas.height !== newHeight) {
    canvas.width = newWidth;
    canvas.height = newHeight;
  }
}

/**
 * A screen capture and the tracks sent from it. The preview shows what is sent, so that the presenter sees exactly
 * what the viewers get, including the black screen while hidden and the blur.
 */
interface Capture {
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
function prepareCapture(stream: MediaStream, hidden: boolean, blurStrength: number | null): Capture {
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
}

/**
 * The video track that the senders get: the blurred one while blurred
 */
function sentVideo(capture: Capture): MediaStreamTrack | null {
  return capture.blur?.track ?? capture.video;
}

/**
 * Hiding disables every track, including the input of the blur, so that turning the blur on or off while hidden
 * never shows the screen.
 */
function setCaptureHidden(capture: Capture, hidden: boolean): void {
  for (const track of [capture.video, capture.blur?.track, capture.audio]) {
    if (track != null) {
      track.enabled = !hidden;
    }
  }
}

function stopCapture(capture: Capture): void {
  capture.blur?.stop();

  for (const track of capture.stream.getTracks()) {
    track.stop();
  }
}

/**
 * The screen this client presents. It has one connection per recipient, keyed by participant ID and connection ID.
 * Until the server accepts the presentation, it has no stream ID and no connections.
 *
 * Every connection has one video and one audio transceiver, even for a capture without audio. Switching the screen
 * or hiding it then only replaces or disables tracks, without a new negotiation.
 */
class OutgoingStream {
  private readonly rtcConfig: RTCConfiguration;
  private readonly sendMessage: MessageSender;
  private readonly peers = new Map<string, OutgoingPeer>();
  private currentStreamId: string | null = null;

  private capture: Capture;

  /**
   * The capture that is being switched to, until every connection sends it
   */
  private pending: Capture | null = null;

  /**
   * Gives the transceivers a stream to announce, which stays the same when the screen is switched
   */
  private readonly sendStream = new MediaStream();

  private isHidden = false;
  private isBlurred = false;
  private blurStrength: number;
  private stopped = false;

  /**
   * The participants of the last sync, to reopen connections after a switch
   */
  private lastSync: { participants: ParticipantState[]; selfId: string } | null = null;

  private quality: QualitySettings;

  constructor(
    mediaStream: MediaStream,
    rtcConfig: RTCConfiguration,
    sendMessage: MessageSender,
    quality: QualitySettings,
    blurStrength: number,
  ) {
    this.quality = quality;
    this.blurStrength = blurStrength;
    this.capture = prepareCapture(mediaStream, false, null);
    this.tuneCapture(this.capture);
    this.rtcConfig = rtcConfig;
    this.sendMessage = sendMessage;
  }

  /**
   * Applies new quality settings to the capture and to every connection
   */
  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.tuneCapture(this.capture);

    if (this.pending != null) {
      this.tuneCapture(this.pending);
    }

    this.applyQualityToPeers();
  }

  /**
   * Applies the quality settings again, after the size of the capture changed
   */
  refreshQuality(): void {
    this.applyQualityToPeers();
  }

  /**
   * The stream ID assigned by the server, or null while awaiting approval
   */
  get streamId(): string | null {
    return this.currentStreamId;
  }

  /**
   * The current capture, shown in the preview
   */
  get mediaStream(): MediaStream {
    return this.capture.stream;
  }

  /**
   * What the preview shows: the same video as the viewers get
   */
  get previewStream(): MediaStream {
    return this.capture.preview;
  }

  get hidden(): boolean {
    return this.isHidden;
  }

  get blurred(): boolean {
    return this.isBlurred;
  }

  /**
   * Turns the screen black and silent for the viewers and in the preview, or shows it again. The connections stay open.
   */
  setHidden(hidden: boolean): void {
    this.isHidden = hidden;
    setCaptureHidden(this.capture, hidden);

    if (this.pending != null) {
      setCaptureHidden(this.pending, hidden);
    }

    this.sendStreamState();
  }

  /**
   * Switches every connection to a new capture. If any connection rejects it, every connection goes back to the
   * current capture, the new one is stopped, and the result is false.
   */
  async replaceCapture(mediaStream: MediaStream): Promise<boolean> {
    if (this.stopped || this.pending != null) {
      for (const track of mediaStream.getTracks()) {
        track.stop();
      }

      return false;
    }

    let next: Capture;

    try {
      next = prepareCapture(mediaStream, this.isHidden, this.isBlurred ? this.blurStrength : null);
    } catch (error) {
      console.warn("Could not prepare the new capture.", error);

      for (const track of mediaStream.getTracks()) {
        track.stop();
      }

      return false;
    }

    this.tuneCapture(next);

    return this.changeCapture(
      next,
      () => stopCapture(next),
      (previous) => stopCapture(previous),
    );
  }

  /**
   * Blurs the screen for the viewers and in the preview, or shows it sharp again. Like a switch, it goes back if any
   * connection rejects the new track.
   */
  async setBlurred(blurred: boolean): Promise<boolean> {
    if (this.stopped || this.pending != null) {
      return false;
    }

    if (blurred === this.isBlurred) {
      return true;
    }

    const current = this.capture;

    if (current.video == null) {
      return false;
    }

    let blur: BlurProcessor | null = null;

    try {
      blur = blurred ? new BlurProcessor(current.video, this.blurStrength) : null;
    } catch (error) {
      console.warn("Could not blur the screen.", error);
      return false;
    }

    const next: Capture = { ...current, blur, preview: blur == null ? current.stream : new MediaStream([blur.track]) };
    setCaptureHidden(next, this.isHidden);

    const changed = await this.changeCapture(
      next,
      () => blur?.stop(),
      (previous) => previous.blur?.stop(),
    );

    if (changed) {
      this.isBlurred = blurred;
    }

    return changed;
  }

  /**
   * Changes the strength of the blur, now if blurred, or for the next time
   */
  setBlurStrength(strength: number): void {
    this.blurStrength = strength;
    this.capture.blur?.setStrength(strength);
    this.pending?.blur?.setStrength(strength);
  }

  /**
   * Replaces the tracks of every connection with those of the next capture. If any connection rejects them, every
   * connection goes back to the current capture, discard() releases the next one, and the result is false. Otherwise,
   * release() gets the previous capture.
   */
  private async changeCapture(
    next: Capture,
    discard: () => void,
    release: (previous: Capture) => void,
  ): Promise<boolean> {
    const previous = this.capture;
    this.pending = next;

    const peers = [...this.peers.values()];
    const results = await Promise.allSettled(
      peers.map(async (peer) => {
        await peer.videoSender.replaceTrack(sentVideo(next));
        await peer.audioSender.replaceTrack(next.audio);
      }),
    );

    this.pending = null;

    if (this.stopped) {
      discard();
      return false;
    }

    // A connection that closed meanwhile does not count
    const failed = results.some((result, index) => result.status === "rejected" && this.isOpenPeer(peers[index]));

    if (failed) {
      await Promise.allSettled(
        [...this.peers.values()].map(async (peer) => {
          await peer.videoSender.replaceTrack(sentVideo(previous));
          await peer.audioSender.replaceTrack(previous.audio);
        }),
      );

      discard();
      return false;
    }

    this.capture = next;
    release(previous);

    // Connections opened during the change still send the previous tracks. Reopen them.
    for (const [participantId, peer] of this.peers) {
      if (peer.videoSender.track !== sentVideo(next) || peer.audioSender.track !== next.audio) {
        peer.link.close();
        this.peers.delete(participantId);
      }
    }

    if (this.lastSync != null) {
      this.sync(this.lastSync.participants, this.lastSync.selfId);
    }

    // The new track may have another height, and a sender that had no track, such as the audio of a capture without
    // audio, has no limits yet
    this.applyQualityToPeers();

    return true;
  }

  /**
   * Returns to awaiting approval. The capture keeps running.
   */
  reset(): void {
    this.closePeers();
    this.currentStreamId = null;
  }

  /**
   * Adopts the stream ID from "presentaccepted". Connections are rebuilt on the next sync.
   */
  adopt(streamId: string): void {
    this.closePeers();
    this.currentStreamId = streamId;

    // The server shows every new stream at first
    if (this.isHidden) {
      this.sendStreamState();
    }
  }

  /**
   * Opens a connection to every other connected participant and closes the connections to participants that left or
   * reconnected.
   */
  sync(participants: ParticipantState[], selfId: string): void {
    this.lastSync = { participants, selfId };

    const streamId = this.currentStreamId;

    if (streamId == null) {
      return;
    }

    const recipients = new Map<string, string>();

    for (const participant of participants) {
      if (participant.connected && participant.id !== selfId) {
        recipients.set(participant.id, participant.connectionId);
      }
    }

    for (const [participantId, peer] of this.peers) {
      if (recipients.get(participantId) !== peer.connectionId) {
        peer.link.close();
        this.peers.delete(participantId);
      }
    }

    for (const [participantId, connectionId] of recipients) {
      if (!this.peers.has(participantId)) {
        this.addPeer(participantId, connectionId, streamId);
      }
    }
  }

  async handleSignal(message: MessageSignalFromServer): Promise<void> {
    if (message.streamId !== this.currentStreamId) {
      return;
    }

    const peer = this.peers.get(message.from);

    if (peer == null || peer.connectionId !== message.fromConnection) {
      return;
    }

    switch (message.kind) {
      case "answer":
        await peer.link.setRemoteDescription(message.message);
        break;
      case "candidate":
        await peer.link.addIceCandidate(message.message);
        break;
    }
  }

  /**
   * Stops the capture and closes every connection.
   */
  stop(): void {
    // A switch in progress sees this and stops its new capture
    this.stopped = true;
    this.closePeers();
    this.currentStreamId = null;
    stopCapture(this.capture);
  }

  private isOpenPeer(peer: OutgoingPeer): boolean {
    return [...this.peers.values()].includes(peer) && peer.link.connection.connectionState !== "closed";
  }

  /**
   * Sets the content hint and the capture frame rate of the video track. Failures are ignored: the encoding limits
   * still apply.
   */
  private tuneCapture(capture: Capture): void {
    const video = capture.video;

    if (video == null) {
      return;
    }

    video.contentHint = contentHintFor(this.quality.degradation);
    video.applyConstraints({ frameRate: { ideal: this.quality.frameRate } }).catch((error: unknown) => {
      console.warn("Could not set the frame rate of the capture.", error);
    });
  }

  /**
   * Connections that are still gathering ICE candidates get the settings when they finish
   */
  private applyQualityToPeers(): void {
    for (const peer of this.peers.values()) {
      if (peer.link.connection.iceGatheringState === "complete") {
        this.queueQuality(peer);
      }
    }
  }

  /**
   * The connection to each recipient, for the statistics
   */
  connections(): { participantId: string; connection: RTCPeerConnection }[] {
    return [...this.peers].map(([participantId, peer]) => ({ participantId, connection: peer.link.connection }));
  }

  private queueQuality(peer: OutgoingPeer): void {
    peer.applyingQuality = peer.applyingQuality.then(() => applyQuality(peer.link.connection, this.quality));
  }

  private sendStreamState(): void {
    if (this.currentStreamId != null) {
      this.sendMessage({ type: "streamstate", streamId: this.currentStreamId, hidden: this.isHidden });
    }
  }

  private closePeers(): void {
    for (const peer of this.peers.values()) {
      peer.link.close();
    }

    this.peers.clear();
  }

  private addPeer(participantId: string, connectionId: string, streamId: string): void {
    const link = new PeerLink(this.rtcConfig);
    const connection = link.connection;
    const options: RTCRtpTransceiverInit = { direction: "sendonly", streams: [this.sendStream] };
    const video = connection.addTransceiver(sentVideo(this.capture) ?? "video", options);
    const audio = connection.addTransceiver(this.capture.audio ?? "audio", options);

    const peer: OutgoingPeer = {
      connectionId,
      link,
      videoSender: video.sender,
      audioSender: audio.sender,
      applyingQuality: Promise.resolve(),
    };

    this.peers.set(participantId, peer);

    connection.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate == null) {
        return;
      }

      this.sendMessage({
        type: "signal",
        to: participantId,
        toConnection: connectionId,
        streamId,
        kind: "candidate",
        message: event.candidate.toJSON(),
      });
    };

    connection.onicegatheringstatechange = () => {
      if (connection.iceGatheringState === "complete") {
        this.queueQuality(peer);
      }
    };

    void this.sendOffer(link, participantId, connectionId, streamId);
  }

  private async sendOffer(link: PeerLink, participantId: string, connectionId: string, streamId: string) {
    try {
      const offer = await link.connection.createOffer();
      await link.connection.setLocalDescription(offer);
    } catch (error) {
      console.warn("Could not create an offer.", error);
      return;
    }

    const localDescription = link.connection.localDescription;

    // The connection may have been replaced while the offer was created
    if (localDescription == null || this.peers.get(participantId)?.link !== link) {
      return;
    }

    this.sendMessage({
      type: "signal",
      to: participantId,
      toConnection: connectionId,
      streamId,
      kind: "offer",
      message: localDescription.toJSON(),
    });
  }
}

/**
 * What the menu shows about one connection. Values that the browser does not report are null.
 */
interface ConnectionStats {
  state: RTCPeerConnectionState;
  route: "direct" | "relay" | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  /**
   * Video and audio together, in bits per second, since the previous sample
   */
  bitrate: number | null;
  /**
   * In seconds
   */
  roundTripTime: number | null;
  /**
   * The share of lost packets since the previous sample, from 0 to 1
   */
  packetLoss: number | null;
  /**
   * Why the encoder lowers the quality: "none", "bandwidth", "cpu" or "other". Only for sent streams.
   */
  limitation: string | null;
}

type StatsDirection = "receive" | "send";

type StatsEntry = Record<string, unknown>;

function statNumber(entry: StatsEntry | undefined, key: string): number | null {
  const value = entry?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statString(entry: StatsEntry | undefined, key: string): string | null {
  const value = entry?.[key];
  return typeof value === "string" ? value : null;
}

/**
 * Reads getStats() of connections. It keeps the previous sample of each connection, to turn the byte and packet
 * counters into a bitrate and a loss rate.
 */
class StatsCollector {
  private readonly previous = new WeakMap<
    RTCPeerConnection,
    { timestamp: number; bytes: number; lost: number; packets: number }
  >();

  async collect(connection: RTCPeerConnection, direction: StatsDirection): Promise<ConnectionStats> {
    const report = await connection.getStats();
    const entries = new Map<string, StatsEntry>();
    report.forEach((entry: StatsEntry, id: string) => {
      entries.set(id, entry);
    });

    const rtpType = direction === "receive" ? "inbound-rtp" : "outbound-rtp";
    let video: StatsEntry | undefined;
    let audio: StatsEntry | undefined;
    let pair: StatsEntry | undefined;
    const remoteInbound: StatsEntry[] = [];

    for (const entry of entries.values()) {
      if (entry.type === rtpType) {
        if (entry.kind === "video") {
          video = entry;
        } else if (entry.kind === "audio") {
          audio = entry;
        }
      } else if (entry.type === "remote-inbound-rtp") {
        remoteInbound.push(entry);
      } else if (entry.type === "transport") {
        const pairId = statString(entry, "selectedCandidatePairId");
        pair = pairId == null ? pair : entries.get(pairId);
      }
    }

    pair ??= [...entries.values()].find(
      (entry) => entry.type === "candidate-pair" && entry.nominated === true && entry.state === "succeeded",
    );

    const localType = statString(entries.get(statString(pair, "localCandidateId") ?? ""), "candidateType");
    const remoteType = statString(entries.get(statString(pair, "remoteCandidateId") ?? ""), "candidateType");
    const route =
      localType == null || remoteType == null
        ? null
        : localType === "relay" || remoteType === "relay"
          ? "relay"
          : "direct";

    // A sender without a track, such as the audio of a capture without audio, still reports a codec. Only name the
    // codec of packets that actually flow.
    const packetKey = direction === "receive" ? "packetsReceived" : "packetsSent";
    const codec = (rtp: StatsEntry | undefined) => {
      if ((statNumber(rtp, packetKey) ?? 0) === 0) {
        return null;
      }

      const mimeType = statString(entries.get(statString(rtp, "codecId") ?? ""), "mimeType");
      return mimeType?.split("/")[1] ?? null;
    };

    // Counters for the rates
    const byteKey = direction === "receive" ? "bytesReceived" : "bytesSent";
    const bytes = (statNumber(video, byteKey) ?? 0) + (statNumber(audio, byteKey) ?? 0);
    let lost: number;
    let packets: number;

    if (direction === "receive") {
      lost = (statNumber(video, "packetsLost") ?? 0) + (statNumber(audio, "packetsLost") ?? 0);
      packets = lost + (statNumber(video, "packetsReceived") ?? 0) + (statNumber(audio, "packetsReceived") ?? 0);
    } else {
      lost = remoteInbound.reduce((sum, entry) => sum + (statNumber(entry, "packetsLost") ?? 0), 0);
      packets = (statNumber(video, "packetsSent") ?? 0) + (statNumber(audio, "packetsSent") ?? 0);
    }

    const timestamp = statNumber(video, "timestamp") ?? statNumber(pair, "timestamp") ?? performance.now();
    const previous = this.previous.get(connection);
    this.previous.set(connection, { timestamp, bytes, lost, packets });

    let bitrate: number | null = null;
    let packetLoss: number | null = packets > 0 ? lost / packets : null;

    if (previous != null && timestamp > previous.timestamp) {
      bitrate = ((bytes - previous.bytes) * 8 * 1000) / (timestamp - previous.timestamp);

      const newPackets = packets - previous.packets;
      packetLoss = newPackets > 0 ? Math.max(0, lost - previous.lost) / newPackets : packetLoss;
    }

    const remoteVideo = remoteInbound.find((entry) => entry.kind === "video");

    return {
      state: connection.connectionState,
      route,
      videoCodec: codec(video),
      audioCodec: codec(audio),
      width: statNumber(video, "frameWidth"),
      height: statNumber(video, "frameHeight"),
      frameRate: statNumber(video, "framesPerSecond"),
      bitrate,
      roundTripTime:
        (direction === "send" ? statNumber(remoteVideo, "roundTripTime") : null) ??
        statNumber(pair, "currentRoundTripTime"),
      packetLoss,
      limitation: direction === "send" ? statString(video, "qualityLimitationReason") : null,
    };
  }
}

/**
 * A screen that another participant presents to this client.
 */
class IncomingStream {
  public readonly streamId: string;
  public readonly presenterId: string;
  public readonly presenterConnection: string;
  public mediaStream: MediaStream | null = null;
  public onstream: (() => void) | null = null;

  private readonly link: PeerLink;
  private readonly sendMessage: MessageSender;

  get connection(): RTCPeerConnection {
    return this.link.connection;
  }

  constructor(
    streamId: string,
    presenterId: string,
    presenterConnection: string,
    rtcConfig: RTCConfiguration,
    sendMessage: MessageSender,
  ) {
    this.streamId = streamId;
    this.presenterId = presenterId;
    this.presenterConnection = presenterConnection;
    this.sendMessage = sendMessage;
    this.link = new PeerLink(rtcConfig);

    this.link.connection.ontrack = (event: RTCTrackEvent) => {
      this.mediaStream = event.streams[0] ?? new MediaStream([event.track]);
      this.onstream?.();
    };

    this.link.connection.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate == null) {
        return;
      }

      this.sendMessage({
        type: "signal",
        to: presenterId,
        toConnection: presenterConnection,
        streamId,
        kind: "candidate",
        message: event.candidate.toJSON(),
      });
    };
  }

  /**
   * Handles an offer or an ICE candidate. A later offer on the same connection renegotiates it.
   */
  async handleSignal(message: MessageSignalFromServer): Promise<void> {
    const connection = this.link.connection;

    switch (message.kind) {
      case "offer": {
        await this.link.setRemoteDescription(message.message);
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);

        const localDescription = connection.localDescription;

        if (localDescription == null) {
          return;
        }

        this.sendMessage({
          type: "signal",
          to: this.presenterId,
          toConnection: this.presenterConnection,
          streamId: this.streamId,
          kind: "answer",
          message: localDescription.toJSON(),
        });
        break;
      }
      case "candidate":
        await this.link.addIceCandidate(message.message);
        break;
    }
  }

  close(): void {
    this.link.close();
  }
}

/**
 * The page elements. Every translation file has the same element IDs.
 */
class Ui {
  public onpresent: (() => void) | null = null;
  public onstop: (() => void) | null = null;
  /**
   * Must call getDisplayMedia synchronously, like onconfirm
   */
  public onswitch: (() => void) | null = null;
  public onhide: ((hidden: boolean) => void) | null = null;
  public onblur: ((blurred: boolean) => void) | null = null;
  public onblurstrength: ((strength: number) => void) | null = null;
  public onqualitychange: ((quality: QualitySettings) => void) | null = null;
  /**
   * The size of the video changed, for example when the presenter resizes the shared window
   */
  public onvideoresize: (() => void) | null = null;
  /**
   * The name typed in the menu, trimmed. It may be empty.
   */
  public onnamechange: ((name: string) => void) | null = null;
  public onmenutoggle: ((open: boolean) => void) | null = null;
  /**
   * The name typed in the dialog, and the presenter chosen to take over in a full room, or null
   */
  public onconfirm: ((name: string, replace: string | null) => void) | null = null;
  public oncancel: (() => void) | null = null;

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

  private readonly toolbar: HTMLElement;
  private readonly presentButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly switchButton: HTMLButtonElement;
  private readonly hideButton: HTMLButtonElement;
  private readonly showButton: HTMLButtonElement;
  private readonly blurButton: HTMLButtonElement;
  private readonly unblurButton: HTMLButtonElement;
  private readonly blurStrengthControl: HTMLElement;
  private readonly blurStrengthInput: HTMLInputElement;
  private readonly blurStrengthValue: HTMLOutputElement;
  private readonly frameRateSelect: HTMLSelectElement;
  private readonly resolutionSelect: HTMLSelectElement;
  private readonly bitrateInput: HTMLInputElement;
  private readonly degradationSelect: HTMLSelectElement;
  private readonly roomLink: HTMLInputElement;
  private readonly copyLinkDone: HTMLElement;
  private readonly copyLinkFailed: HTMLElement;
  private readonly menuNameInput: HTMLInputElement;
  private readonly participantList: HTMLElement;
  private readonly participantsSection: HTMLElement;
  private readonly qualitySection: HTMLElement;
  private copyFeedbackTimer: number | null = null;
  private readonly statsList: HTMLElement;
  private readonly statsEmpty: HTMLElement;
  private readonly statsTemplate: HTMLTemplateElement;
  private readonly statsNames: HTMLElement;

  /**
   * The settings shown in the menu. An invalid input goes back to them.
   */
  private quality: QualitySettings = DEFAULT_QUALITY;
  private readonly viewerCount: HTMLElement;
  private readonly viewerCountValue: HTMLElement;
  private readonly status: HTMLElement;
  private readonly dialog: HTMLDialogElement;
  private readonly nameInput: HTMLInputElement;
  private readonly anonymousName: string;
  private readonly youText: string;
  private readonly presentingText: string;
  private readonly reconnectingText: string;
  private readonly noticeTimers = new Map<NoticeId, number>();

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
    this.toolbar = getElement("toolbar", HTMLElement);
    this.presentButton = getElement("present-button", HTMLButtonElement);
    this.stopButton = getElement("stop-button", HTMLButtonElement);
    this.switchButton = getElement("switch-button", HTMLButtonElement);
    this.hideButton = getElement("hide-button", HTMLButtonElement);
    this.showButton = getElement("show-button", HTMLButtonElement);
    this.blurButton = getElement("blur-button", HTMLButtonElement);
    this.unblurButton = getElement("unblur-button", HTMLButtonElement);
    this.blurStrengthControl = getElement("blur-strength-control", HTMLElement);
    this.blurStrengthInput = getElement("blur-strength", HTMLInputElement);
    this.blurStrengthValue = getElement("blur-strength-value", HTMLOutputElement);
    this.frameRateSelect = getElement("quality-frame-rate", HTMLSelectElement);
    this.resolutionSelect = getElement("quality-resolution", HTMLSelectElement);
    this.bitrateInput = getElement("quality-bitrate", HTMLInputElement);
    this.degradationSelect = getElement("quality-degradation", HTMLSelectElement);
    this.roomLink = getElement("room-link", HTMLInputElement);
    this.copyLinkDone = getElement("copy-link-done", HTMLElement);
    this.copyLinkFailed = getElement("copy-link-failed", HTMLElement);
    this.menuNameInput = getElement("menu-name-input", HTMLInputElement);
    this.participantList = getElement("participant-list", HTMLElement);
    this.participantsSection = getElement("menu-participants", HTMLElement);
    this.qualitySection = getElement("menu-quality", HTMLElement);
    this.statsList = getElement("stats-list", HTMLElement);
    this.statsEmpty = getElement("stats-empty", HTMLElement);
    this.statsTemplate = getElement("stats-template", HTMLTemplateElement);
    this.statsNames = getElement("stats-names", HTMLElement);

    const menu = getElement("menu", HTMLElement);
    menu.addEventListener("toggle", () => this.onmenutoggle?.(menu.matches(":popover-open")));
    this.viewerCount = getElement("viewer-count", HTMLElement);
    this.viewerCountValue = getElement("viewer-count-value", HTMLElement);
    this.status = getElement("status", HTMLElement);
    this.dialog = getElement("present-dialog", HTMLDialogElement);
    this.nameInput = getElement("present-name", HTMLInputElement);
    this.anonymousName = getElement("text-anonymous", HTMLElement).textContent.trim();
    this.youText = getElement("text-you", HTMLElement).textContent.trim();
    this.presentingText = getElement("text-presenting", HTMLElement).textContent.trim();
    this.reconnectingText = getElement("text-reconnecting", HTMLElement).textContent.trim();

    // The page reloads when the hash changes, so the link stays the same
    this.roomLink.value = location.href;
    getElement("copy-link-button", HTMLButtonElement).addEventListener("click", () => this.copyLink());

    this.menuNameInput.addEventListener("change", () => this.onnamechange?.(this.menuNameInput.value.trim()));

    this.presentButton.addEventListener("click", () => this.onpresent?.());
    this.stopButton.addEventListener("click", () => this.onstop?.());
    this.switchButton.addEventListener("click", () => this.onswitch?.());
    this.hideButton.addEventListener("click", () => this.onhide?.(true));
    this.showButton.addEventListener("click", () => this.onhide?.(false));
    this.blurButton.addEventListener("click", () => this.onblur?.(true));
    this.unblurButton.addEventListener("click", () => this.onblur?.(false));

    // Applied while the slider moves: the size of the sent video does not change with the strength
    this.blurStrengthInput.addEventListener("input", () => {
      const strength = Number(this.blurStrengthInput.value);

      if (isValidBlurStrength(strength)) {
        this.blurStrengthValue.value = strength.toString();
        this.onblurstrength?.(strength);
      }
    });

    this.frameRateSelect.addEventListener("change", () => {
      const frameRate = Number(this.frameRateSelect.value);
      this.changeQuality(isValidFrameRate(frameRate) ? { frameRate } : null);
    });

    this.resolutionSelect.addEventListener("change", () => {
      const maxHeight = this.resolutionSelect.value === "" ? null : Number(this.resolutionSelect.value);
      this.changeQuality(isValidMaxHeight(maxHeight) ? { maxHeight } : null);
    });

    this.bitrateInput.addEventListener("change", () => {
      const maxBitrateMbps = this.bitrateInput.valueAsNumber;
      this.changeQuality(
        this.bitrateInput.checkValidity() && isValidBitrate(maxBitrateMbps) ? { maxBitrateMbps } : null,
      );
    });

    this.degradationSelect.addEventListener("change", () => {
      const degradation = this.degradationSelect.value;
      this.changeQuality(isValidDegradation(degradation) ? { degradation } : null);
    });

    // The confirm handler must run synchronously in the submit event, so that getDisplayMedia still has the user
    // activation of the click
    getElement("present-form", HTMLFormElement).addEventListener("submit", (event: SubmitEvent) => {
      event.preventDefault();
      const name = this.nameInput.value.trim();
      const replace = this.dialog.querySelector<HTMLInputElement>('input[name="replace"]:checked')?.value ?? null;
      this.dialog.close();
      this.onconfirm?.(name, replace);
    });

    getElement("present-cancel", HTMLButtonElement).addEventListener("click", () => {
      this.dialog.close();
      this.oncancel?.();
    });

    this.dialog.addEventListener("cancel", (event: Event) => {
      event.preventDefault();
      this.dialog.close();
      this.oncancel?.();
    });

    for (const notice of document.querySelectorAll<HTMLElement>(".notice")) {
      notice.querySelector(".notice-close")?.addEventListener("click", () => this.hideNotice(notice.id as NoticeId));
    }
  }

  /**
   * Shows the own name in the menu, unless it is being edited
   */
  setOwnName(name: string): void {
    if (document.activeElement !== this.menuNameInput) {
      this.menuNameInput.value = name;
    }
  }

  /**
   * Lists the participants in the menu. Names come from other people, so they are only ever set as text.
   */
  showParticipants(
    participants: { id: string; name: string; you: boolean; presenting: boolean; reconnecting: boolean }[],
  ): void {
    const items = participants.map((participant) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.className = "participant-name";
      name.textContent = this.displayName(participant.name, participant.id);
      item.append(name);

      const badges: string[] = [];

      if (participant.presenting) {
        badges.push(participant.reconnecting ? this.reconnectingText : this.presentingText);
      }

      if (participant.you) {
        badges.push(this.youText);
      }

      for (const text of badges) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = text;
        item.append(badge);
      }

      return item;
    });

    this.participantList.replaceChildren(...items);

    for (const slot of this.participantsSection.querySelectorAll(".count-slot")) {
      slot.textContent = participants.length.toString();
    }
  }

  /**
   * Shows the statistics of each connection, from the copy of #stats-template, or #stats-empty without any
   */
  showStats(entries: { name: string; direction: StatsDirection; stats: ConnectionStats }[]): void {
    this.statsEmpty.classList.toggle("hidden", entries.length > 0);

    const blocks = entries.map((entry) => {
      const fragment = this.statsTemplate.content.cloneNode(true) as DocumentFragment;
      const stats = entry.stats;
      const values: Record<string, string> = {
        state: this.statsName("state", stats.state),
        route: this.statsName("route", stats.route),
        video: stats.videoCodec ?? NO_VALUE,
        resolution: stats.width == null || stats.height == null ? NO_VALUE : `${stats.width}×${stats.height}`,
        frameRate: stats.frameRate == null ? NO_VALUE : `${Math.round(stats.frameRate)} fps`,
        bitrate: formatBitrate(stats.bitrate),
        audio: stats.audioCodec ?? NO_VALUE,
        roundTripTime: stats.roundTripTime == null ? NO_VALUE : `${Math.round(stats.roundTripTime * 1000)} ms`,
        packetLoss: stats.packetLoss == null ? NO_VALUE : `${(stats.packetLoss * 100).toFixed(1)}%`,
        limitation: this.statsName("limitation", stats.limitation),
      };

      for (const name of fragment.querySelectorAll(".stats-name")) {
        name.textContent = entry.name;
      }

      // The presenter can both send to and receive from another presenter
      for (const direction of fragment.querySelectorAll(".stats-direction")) {
        direction.textContent = this.statsName("direction", entry.direction);
      }

      for (const field of fragment.querySelectorAll<HTMLElement>("[data-field]")) {
        field.textContent = values[field.dataset.field ?? ""] ?? NO_VALUE;
      }

      // Only the presenter's encoder lowers the quality
      for (const element of fragment.querySelectorAll("[data-send-only]")) {
        element.classList.toggle("hidden", entry.direction !== "send");
      }

      return fragment;
    });

    this.statsList.replaceChildren(...blocks);
  }

  /**
   * The translated name of a state, a route or a limitation, from #stats-names
   */
  private statsName(kind: "state" | "route" | "limitation" | "direction", value: string | null): string {
    if (value == null) {
      return NO_VALUE;
    }

    const element = this.statsNames.querySelector(`[data-${kind}="${CSS.escape(value)}"]`);
    return element?.textContent.trim() ?? value;
  }

  showQualitySection(visible: boolean): void {
    this.qualitySection.classList.toggle("hidden", !visible);
  }

  private copyLink(): void {
    const succeed = () => this.showCopyFeedback(this.copyLinkDone);
    const fail = () => {
      // Let the person copy it themselves
      this.roomLink.focus();
      this.roomLink.select();
      this.showCopyFeedback(this.copyLinkFailed);
    };

    if (navigator.clipboard == null) {
      fail();
      return;
    }

    navigator.clipboard.writeText(this.roomLink.value).then(succeed, fail);
  }

  private showCopyFeedback(element: HTMLElement): void {
    this.copyLinkDone.classList.add("hidden");
    this.copyLinkFailed.classList.add("hidden");
    element.classList.remove("hidden");

    if (this.copyFeedbackTimer != null) {
      window.clearTimeout(this.copyFeedbackTimer);
    }

    // The failure stays, because the person still has to copy the link
    this.copyFeedbackTimer =
      element === this.copyLinkDone
        ? window.setTimeout(() => this.copyLinkDone.classList.add("hidden"), COPY_FEEDBACK_MS)
        : null;
  }

  setBlurStrength(strength: number): void {
    this.blurStrengthInput.value = strength.toString();
    this.blurStrengthValue.value = strength.toString();
  }

  /**
   * Shows the quality settings in the menu
   */
  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.frameRateSelect.value = quality.frameRate.toString();
    this.resolutionSelect.value = quality.maxHeight?.toString() ?? "";
    this.bitrateInput.value = quality.maxBitrateMbps.toString();
    this.degradationSelect.value = quality.degradation;
  }

  /**
   * Reports a valid change, or puts the inputs back to the current settings
   */
  private changeQuality(change: Partial<QualitySettings> | null): void {
    if (change == null) {
      this.setQuality(this.quality);
      return;
    }

    this.quality = { ...this.quality, ...change };
    this.onqualitychange?.(this.quality);
  }

  /**
   * Returns the name to display for a participant.
   */
  displayName(name: string | undefined, participantId: string): string {
    // Someone without a name is a guest numbered by the order of joining, the same on every screen
    return name != null && name !== ""
      ? name
      : this.anonymousName.replace("{number}", (Number(participantId) + 1).toString());
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

  /**
   * Shows a status of the whole page over the stage, or none
   */
  showStatus(id: StatusId | null): void {
    for (const statusId of STATUS_IDS) {
      document.getElementById(statusId)?.classList.toggle("hidden", statusId !== id);
    }

    this.status.classList.toggle("hidden", id == null);
  }

  showToolbar(options: {
    visible: boolean;
    canPresent: boolean;
    presenting: boolean;
    hidden: boolean;
    blurred: boolean;
    canBlur: boolean;
    /**
     * A switch or a blur change is in progress
     */
    busy: boolean;
    viewers: number;
  }): void {
    this.toolbar.classList.toggle("hidden", !options.visible);
    this.presentButton.classList.toggle("hidden", !options.canPresent);
    this.stopButton.classList.toggle("hidden", !options.presenting);
    this.switchButton.classList.toggle("hidden", !options.presenting);
    this.switchButton.disabled = options.busy;
    this.hideButton.classList.toggle("hidden", !options.presenting || options.hidden);
    this.showButton.classList.toggle("hidden", !options.presenting || !options.hidden);
    this.blurButton.classList.toggle("hidden", !options.presenting || !options.canBlur || options.blurred);
    this.unblurButton.classList.toggle("hidden", !options.presenting || !options.canBlur || !options.blurred);
    this.blurStrengthControl.classList.toggle("hidden", !options.presenting || !options.canBlur || !options.blurred);
    this.blurButton.disabled = options.busy;
    this.unblurButton.disabled = options.busy;
    this.viewerCount.classList.toggle("hidden", !options.presenting);
    this.viewerCountValue.textContent = options.viewers.toString();
  }

  showNotice(id: NoticeId, name = ""): void {
    const element = document.getElementById(id);

    if (element == null) {
      return;
    }

    setNameSlots(element, name);
    element.classList.remove("hidden");

    window.clearTimeout(this.noticeTimers.get(id));
    this.noticeTimers.set(
      id,
      window.setTimeout(() => this.hideNotice(id), NOTICE_TIMEOUT_MS),
    );
  }

  hideNotice(id: NoticeId): void {
    window.clearTimeout(this.noticeTimers.get(id));
    this.noticeTimers.delete(id);
    document.getElementById(id)?.classList.add("hidden");
  }

  /**
   * Opens the dialog that starts or resumes presenting.
   *
   * @param mode "start" to start presenting, "resume" to resume after a reload
   * @param full In a full room, its limit and the presenters to choose from, one of whom is taken over; otherwise null
   * @param name The name to fill in
   */
  openDialog(
    mode: DialogMode,
    full: { maxPresenters: number; presenters: { id: string; name: string }[] } | null,
    name: string,
  ): void {
    const replaceable = full?.presenters ?? null;

    for (const element of this.dialog.querySelectorAll<HTMLElement>("[data-mode]")) {
      element.classList.toggle("hidden", element.dataset.mode !== mode);
    }

    // Names come from other people, so they are only ever set as text
    const fieldset = getElement("present-replace", HTMLElement);
    const options = (replaceable ?? []).map((presenter) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "replace";
      input.value = presenter.id;
      input.required = true;
      input.checked = replaceable?.length === 1;
      const name = document.createElement("span");
      name.textContent = presenter.name;
      label.append(input, name);
      return label;
    });

    getElement("present-replace-options", HTMLElement).replaceChildren(...options);
    fieldset.classList.toggle("hidden", replaceable == null);

    for (const slot of fieldset.querySelectorAll(".max-slot")) {
      slot.textContent = full?.maxPresenters.toString() ?? "";
    }

    this.nameInput.value = name;

    if (!this.dialog.open) {
      this.dialog.showModal();
    }
  }

  closeDialog(): void {
    this.dialog.close();
  }
}

/**
 * Keeps this client in sync with the room: presents the local screen, receives the screens of others, and shows the
 * state of the room.
 */
class RoomController {
  private readonly roomId: string;
  private readonly ui: Ui;
  private readonly signaling: SignalingConnection;
  private readonly rtcConfig: RTCConfiguration;
  private readonly canPresent: boolean;
  private readonly sendMessage: MessageSender;

  private selfId: string | null = null;
  private state: MessageRoomState | null = null;

  /**
   * The room state before the current one, to tell who took over a seat
   */
  private previousState: MessageRoomState | null = null;

  /**
   * The number of people that can present at the same time, from "welcome"
   */
  private maxPresenters = 1;

  /**
   * Whether the notice about muting the other presenters was shown for the current capture
   */
  private echoNoticeShown = false;
  private outgoing: OutgoingStream | null = null;
  private readonly incoming = new Map<string, IncomingStream>();

  /**
   * Set by "welcome" while presenting: the next "roomstate" decides whether this client still holds its seat.
   */
  private resolveOnNextState = false;

  /**
   * Whether to open the start dialog when the room state first arrives, for the person who created the room
   */
  private offerToPresent: boolean;

  private dialogMode: DialogMode | null = null;

  /**
   * When the grace period of each reconnecting presenter ends, by participant ID, in performance.now() time. The
   * server sends the time left, so that the clocks of the server and the client do not need to agree.
   */
  private graceDeadlines = new Map<string, number>();

  /**
   * Re-renders every second while a countdown is shown
   */
  private countdownTimer: number | null = null;

  /**
   * From the click on "Switch screen" until the switch is done or abandoned, or while the blur is turned on or off.
   * Only one of them runs at a time.
   */
  private trackChangeInProgress = false;

  private readonly canBlur = isBlurSupported();

  private blurStrength = readBlurStrength();

  private quality: QualitySettings;

  private readonly statsCollector = new StatsCollector();

  /**
   * Collects the statistics every second while the menu is open
   */
  private statsTimer: number | null = null;
  private collectingStats = false;

  /**
   * @param roomId The ID of the room, as typed in the URL hash
   * @param isCreator Whether this client created the room by opening the page without a hash
   */
  constructor(roomId: string, isCreator: boolean) {
    this.roomId = roomId.toLowerCase();
    this.offerToPresent = isCreator;
    this.canPresent = "getDisplayMedia" in navigator.mediaDevices;
    this.ui = new Ui();
    this.quality = readQuality();
    this.ui.setQuality(this.quality);
    this.ui.showQualitySection(this.canPresent);
    this.ui.setOwnName(this.storedName());

    const webSocketProtocol = window.location.protocol === "http:" ? "ws" : "wss";
    this.signaling = new SignalingConnection(`${webSocketProtocol}://${location.host}${location.pathname}`);
    this.sendMessage = (message: ClientMessage) => this.signaling.send(message);

    this.rtcConfig = {
      iceServers: [
        { urls: `stun:${location.hostname}` },
        {
          urls: `turn:${location.hostname}`,
          username: "screensy",
          credential: "screensy",
        },
      ],
    };

    this.signaling.onopen = () => this.join();
    this.signaling.onclose = () => this.render();
    this.signaling.onmessage = (message: ServerMessage) => this.handleMessage(message);

    this.ui.onpresent = () => this.openStartDialog();
    this.ui.onstop = () => this.stopPresenting();
    this.ui.onconfirm = (name: string, replace: string | null) => this.confirmDialog(name, replace);
    this.ui.oncancel = () => this.cancelDialog();
    this.ui.onswitch = () => this.switchScreen();
    this.ui.onhide = (hidden: boolean) => this.setHidden(hidden);
    this.ui.onblur = (blurred: boolean) => this.setBlurred(blurred);
    this.ui.onblurstrength = (strength: number) => this.changeBlurStrength(strength);
    this.ui.setBlurStrength(this.blurStrength);
    this.ui.onqualitychange = (quality: QualitySettings) => this.changeQuality(quality);
    this.ui.onvideoresize = () => this.outgoing?.refreshQuality();
    this.ui.onnamechange = (name: string) => this.changeName(name);
    this.ui.onmenutoggle = (open: boolean) => this.toggleStats(open);

    const roomIdWords = roomId.split(/(?=[A-Z])/);
    document.title = `${roomIdWords.join(" ")} | screensy`;
  }

  start(): void {
    this.render();
    this.signaling.connect();
  }

  close(): void {
    this.signaling.close();
  }

  private get resumeStorageKey(): string {
    return RESUME_STORAGE_PREFIX + this.roomId;
  }

  private join(): void {
    const resumeToken = readStorage(getSessionStorage, this.resumeStorageKey);

    this.sendMessage({
      type: "join",
      roomId: this.roomId,
      name: readStorage(getLocalStorage, NAME_STORAGE_KEY) ?? "",
      ...(resumeToken == null ? {} : { resumeToken }),
    });
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "welcome":
        this.handleWelcome(message);
        break;
      case "roomstate":
        this.handleRoomState(message);
        break;
      case "signal":
        this.handleSignal(message);
        break;
      case "presentaccepted":
        if (this.outgoing != null && this.outgoing.streamId == null && !this.resolveOnNextState) {
          this.outgoing.adopt(message.streamId);
        }
        break;
      case "presentrejected":
        if (this.outgoing == null) {
          break;
        }

        if (message.reason === "full") {
          // Someone else filled the room while the dialog was open
          this.outgoing.stop();
          this.outgoing = null;
          this.ui.showNotice("notice-full");
          this.render();
        } else {
          this.loseSeat();
        }

        break;
      case "replaced":
        // Another tab uses this participant. Join as a new participant when the server closes this socket.
        writeStorage(getSessionStorage, this.resumeStorageKey, null);
        this.handleReplaced();
        break;
    }
  }

  /**
   * The seat, if this client had one, now belongs to the other tab, for example a duplicate of this one. Stop here
   * instead of waiting for the next room state, which would report the seat as taken over by this same person.
   */
  private handleReplaced(): void {
    const hadSeat = this.outgoing != null || this.dialogMode === "resume";

    this.outgoing?.stop();
    this.outgoing = null;
    this.resolveOnNextState = false;

    if (this.dialogMode === "resume") {
      this.dialogMode = null;
      this.ui.closeDialog();
    }

    if (hadSeat) {
      this.ui.showNotice("notice-moved-to-other-tab");
    }

    this.render();
  }

  private handleWelcome(message: MessageWelcome): void {
    this.selfId = message.selfId;
    this.maxPresenters = message.maxPresenters;
    writeStorage(getSessionStorage, this.resumeStorageKey, message.resumeToken);

    // The connection ID changed, so every presenter opens new connections to this client
    this.closeIncoming();

    if (this.outgoing != null) {
      // A "present" may have been lost with the old socket. The next room state tells whether the seat is still ours.
      this.outgoing.reset();
      this.resolveOnNextState = true;
    }
  }

  private handleRoomState(state: MessageRoomState): void {
    this.previousState = this.state;
    this.state = state;

    const now = performance.now();
    this.graceDeadlines = new Map(
      state.presenters.flatMap((presenter) =>
        presenter.graceRemainingMs == null ? [] : [[presenter.participantId, now + presenter.graceRemainingMs]],
      ),
    );

    const selfId = this.selfId;

    if (selfId == null) {
      return;
    }

    const ownSeat = state.presenters.find((presenter) => presenter.participantId === selfId);
    const self = state.participants.find((participant) => participant.id === selfId);

    // The server's version of the name, which also follows a change made in the start dialog
    if (self != null) {
      this.ui.setOwnName(self.name);
    }

    this.showParticipants(state, selfId);

    if (this.outgoing != null) {
      if (this.outgoing.streamId == null) {
        if (this.resolveOnNextState) {
          this.resolveOnNextState = false;

          if (ownSeat == null) {
            this.loseSeat();
          } else {
            this.sendMessage({ type: "present", resume: true });
          }
        }
        // Otherwise the "present" is still on its way, and this state may predate it
      } else if (ownSeat == null) {
        this.loseSeat();
      } else if (ownSeat.status === "reconnecting") {
        this.outgoing.reset();
        this.sendMessage({ type: "present", resume: true });
      } else if (ownSeat.streamId === this.outgoing.streamId) {
        this.outgoing.sync(state.participants, selfId);
      }
    } else if (ownSeat != null) {
      if (ownSeat.status === "live") {
        // The seat has no capture behind it
        this.sendMessage({ type: "stoppresenting" });
      } else if (this.dialogMode !== "resume") {
        // This client reloaded while presenting
        this.dialogMode = "resume";
        this.ui.openDialog("resume", null, this.storedName());
      }
    } else if (this.dialogMode === "resume") {
      // The seat expired or was taken while the resume dialog was open
      this.dialogMode = null;
      this.ui.closeDialog();
      this.showSeatLostNotice();
    }

    for (const [streamId, stream] of this.incoming) {
      const presenter = state.presenters.find((presenter) => presenter.streamId === streamId);
      const participant = state.participants.find((participant) => participant.id === stream.presenterId);

      if (
        presenter == null ||
        presenter.status !== "live" ||
        presenter.participantId !== stream.presenterId ||
        participant?.connectionId !== stream.presenterConnection
      ) {
        stream.close();
        this.incoming.delete(streamId);
      }
    }

    if (this.offerToPresent) {
      this.offerToPresent = false;

      if (this.outgoing == null && ownSeat == null) {
        if (this.canPresent) {
          this.openStartDialog();
        } else {
          showPopup("screensharing-not-supported");
        }
      }
    }

    this.render();
  }

  private handleSignal(message: MessageSignalFromServer): void {
    if (this.outgoing != null && message.streamId === this.outgoing.streamId) {
      this.outgoing.handleSignal(message).catch((error) => console.warn("Could not handle a signal.", error));
      return;
    }

    const state = this.state;

    if (state == null) {
      return;
    }

    const presenter = state.presenters.find(
      (presenter) =>
        presenter.streamId === message.streamId &&
        presenter.participantId === message.from &&
        presenter.status === "live",
    );
    const participant = state.participants.find((participant) => participant.id === message.from);

    if (presenter == null || participant?.connectionId !== message.fromConnection) {
      // A signal of an old stream or an old connection
      return;
    }

    let stream = this.incoming.get(message.streamId);

    if (stream == null) {
      stream = new IncomingStream(
        message.streamId,
        message.from,
        message.fromConnection,
        this.rtcConfig,
        this.sendMessage,
      );
      stream.onstream = () => this.render();
      this.incoming.set(message.streamId, stream);
    }

    stream.handleSignal(message).catch((error) => console.warn("Could not handle a signal.", error));
  }

  private openStartDialog(): void {
    if (this.outgoing != null || !this.canPresent) {
      return;
    }

    // A full room needs one of its presenters to be taken over. Reconnecting presenters still hold their seat.
    const presenters = this.state?.presenters ?? [];
    const full =
      presenters.length >= this.maxPresenters
        ? {
            maxPresenters: this.maxPresenters,
            presenters: presenters.map((presenter) => ({
              id: presenter.participantId,
              name: this.nameOf(presenter.participantId),
            })),
          }
        : null;

    this.dialogMode = "start";
    this.ui.openDialog("start", full, this.storedName());
    this.render();
  }

  private confirmDialog(name: string, replace: string | null): void {
    const mode = this.dialogMode;
    this.dialogMode = null;

    // Call getDisplayMedia before anything else, while the click still counts as a user activation
    let capture: Promise<MediaStream>;

    try {
      capture = navigator.mediaDevices.getDisplayMedia(displayMediaOptions(this.quality));
    } catch (error) {
      capture = Promise.reject(error);
    }

    writeStorage(getLocalStorage, NAME_STORAGE_KEY, name);
    this.render();

    capture.then(
      (mediaStream: MediaStream) => this.beginPresenting(mediaStream, name, mode === "resume", replace),
      () => {
        this.ui.showNotice("notice-access-denied");

        if (mode === "resume") {
          this.sendMessage({ type: "stoppresenting" });
        }

        this.render();
      },
    );
  }

  private cancelDialog(): void {
    if (this.dialogMode === "resume") {
      this.sendMessage({ type: "stoppresenting" });
    }

    this.dialogMode = null;
    this.render();
  }

  private beginPresenting(mediaStream: MediaStream, name: string, resume: boolean, replace: string | null): void {
    this.outgoing?.stop();

    const outgoing = new OutgoingStream(mediaStream, this.rtcConfig, this.sendMessage, this.quality, this.blurStrength);
    this.outgoing = outgoing;

    this.watchCapture(outgoing, mediaStream);

    const self = this.state?.participants.find((participant) => participant.id === this.selfId);

    if (self?.name !== name) {
      this.sendMessage({ type: "setname", name });
    }

    // If the socket is down, this message is lost, and the next "welcome" resolves it
    this.sendMessage({ type: "present", resume, ...(replace == null ? {} : { replace }) });
    this.render();
  }

  /**
   * Stops presenting when the browser's own "Stop sharing" button ends the capture, as long as it is the current one
   */
  private watchCapture(outgoing: OutgoingStream, mediaStream: MediaStream): void {
    for (const track of mediaStream.getVideoTracks()) {
      track.addEventListener("ended", () => {
        if (this.outgoing === outgoing && outgoing.mediaStream === mediaStream) {
          this.stopPresenting();
        }
      });
    }
  }

  /**
   * Lets the presenter choose another screen, without reconnecting to the viewers
   */
  private switchScreen(): void {
    const outgoing = this.outgoing;

    if (outgoing == null || this.trackChangeInProgress) {
      return;
    }

    // Call getDisplayMedia before anything else, while the click still counts as a user activation
    let capture: Promise<MediaStream>;

    try {
      capture = navigator.mediaDevices.getDisplayMedia(displayMediaOptions(this.quality));
    } catch (error) {
      capture = Promise.reject(error);
    }

    this.trackChangeInProgress = true;
    this.render();

    capture
      .then(
        async (mediaStream: MediaStream) => {
          if (this.outgoing !== outgoing) {
            // Stopped or taken over while the picker was open
            for (const track of mediaStream.getTracks()) {
              track.stop();
            }

            return;
          }

          this.watchCapture(outgoing, mediaStream);
          const switched = await outgoing.replaceCapture(mediaStream);

          if (this.outgoing !== outgoing) {
            return;
          }

          if (!switched) {
            this.ui.showNotice("notice-switch-failed");
          } else if (mediaStream.getVideoTracks()[0]?.readyState === "ended") {
            // Sharing ended before the switch was complete
            this.stopPresenting();
          }
        },
        () => {
          // Cancelled or denied. The current screen stays.
        },
      )
      .finally(() => {
        this.trackChangeInProgress = false;
        this.render();
      });
  }

  /**
   * Remembers the name and tells the room. While disconnected, the next "join" carries it.
   */
  private changeName(name: string): void {
    writeStorage(getLocalStorage, NAME_STORAGE_KEY, name);

    if (this.signaling.isOpen && this.selfId != null) {
      this.sendMessage({ type: "setname", name });
    }
  }

  private showParticipants(state: MessageRoomState, selfId: string): void {
    const seats = new Map(state.presenters.map((presenter) => [presenter.participantId, presenter]));
    const rank = (id: string) => (seats.has(id) ? 0 : id === selfId ? 1 : 2);
    const participants = [...state.participants].sort((a, b) => rank(a.id) - rank(b.id));

    this.ui.showParticipants(
      participants.map((participant) => ({
        id: participant.id,
        name: participant.name,
        you: participant.id === selfId,
        presenting: seats.has(participant.id),
        reconnecting: seats.get(participant.id)?.status === "reconnecting",
      })),
    );
  }

  private toggleStats(open: boolean): void {
    if (open && this.statsTimer == null) {
      this.statsTimer = window.setInterval(() => void this.updateStats(), STATS_INTERVAL_MS);
      void this.updateStats();
    } else if (!open && this.statsTimer != null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  /**
   * One entry per viewer that this client sends to, and one per presentation that it receives
   */
  private async updateStats(): Promise<void> {
    if (this.collectingStats) {
      return;
    }

    this.collectingStats = true;

    try {
      const targets: { name: string; direction: StatsDirection; connection: RTCPeerConnection }[] = [];

      for (const { participantId, connection } of this.outgoing?.connections() ?? []) {
        targets.push({ name: this.nameOf(participantId), direction: "send", connection });
      }

      for (const presenter of this.state?.presenters ?? []) {
        const stream = this.incoming.get(presenter.streamId);

        if (presenter.participantId !== this.selfId && presenter.status === "live" && stream != null) {
          targets.push({
            name: this.nameOf(presenter.participantId),
            direction: "receive",
            connection: stream.connection,
          });
        }
      }

      const entries = await Promise.all(
        targets.map(async (target) => ({
          name: target.name,
          direction: target.direction,
          stats: await this.statsCollector.collect(target.connection, target.direction),
        })),
      );

      // The menu may have closed meanwhile
      if (this.statsTimer != null) {
        this.ui.showStats(entries);
      }
    } catch (error) {
      console.warn("Could not read the connection statistics.", error);
    } finally {
      this.collectingStats = false;
    }
  }

  private changeQuality(quality: QualitySettings): void {
    this.quality = quality;
    writeQuality(quality);
    this.outgoing?.setQuality(quality);
  }

  private setBlurred(blurred: boolean): void {
    const outgoing = this.outgoing;

    if (outgoing == null || this.trackChangeInProgress) {
      return;
    }

    this.trackChangeInProgress = true;
    this.render();

    outgoing
      .setBlurred(blurred)
      .then((changed: boolean) => {
        if (!changed && this.outgoing === outgoing) {
          this.ui.showNotice("notice-blur-failed");
        }
      })
      .finally(() => {
        this.trackChangeInProgress = false;
        this.render();
      });
  }

  private changeBlurStrength(strength: number): void {
    this.blurStrength = strength;
    writeStorage(getLocalStorage, BLUR_STORAGE_KEY, strength.toString());
    this.outgoing?.setBlurStrength(strength);
  }

  private setHidden(hidden: boolean): void {
    this.outgoing?.setHidden(hidden);
    this.render();
  }

  private stopPresenting(): void {
    if (this.outgoing == null) {
      return;
    }

    this.sendMessage({ type: "stoppresenting" });
    this.outgoing.stop();
    this.outgoing = null;
    this.render();
  }

  /**
   * Stops the capture after the seat was taken over or lost.
   */
  private loseSeat(): void {
    this.outgoing?.stop();
    this.outgoing = null;
    this.showSeatLostNotice();
    this.render();
  }

  /**
   * Names the presenter who took over the seat: one who is new in the latest room state
   */
  private showSeatLostNotice(): void {
    const before = new Set(this.previousState?.presenters.map((presenter) => presenter.participantId) ?? []);
    const presenter = this.state?.presenters.find(
      (presenter) => presenter.participantId !== this.selfId && !before.has(presenter.participantId),
    );

    if (presenter == null) {
      this.ui.showNotice("notice-connection-lost");
    } else {
      this.ui.showNotice("notice-taken-over", this.nameOf(presenter.participantId));
    }
  }

  private closeIncoming(): void {
    for (const stream of this.incoming.values()) {
      stream.close();
    }

    this.incoming.clear();
  }

  private storedName(): string {
    return readStorage(getLocalStorage, NAME_STORAGE_KEY) ?? "";
  }

  private nameOf(participantId: string): string {
    const participant = this.state?.participants.find((participant) => participant.id === participantId);
    return this.ui.displayName(participant?.name, participantId);
  }

  /**
   * Updates the video, the status and the toolbar from the current state.
   */
  private render(): void {
    const state = this.state;
    const ready = this.signaling.isOpen && state != null && this.selfId != null;
    const tiles = ready ? this.tileViews(state) : [];

    // While the server is away, only the own preview stays
    if (!ready && this.outgoing != null) {
      tiles.push(this.ownTile());
    }

    let status: StatusId | null = null;

    if (!this.signaling.everConnected) {
      status = "status-connecting";
    } else if (!this.signaling.isOpen) {
      status = "status-server-reconnecting";
    } else if (state == null) {
      status = "status-connecting";
    } else if (tiles.length === 0) {
      status = "status-waiting";
    }

    this.ui.showTiles(tiles);
    this.ui.showStatus(status);
    this.updateEchoProtection(tiles);

    const counting = tiles.some((tile) => tile.countdown != null);

    if (counting && this.countdownTimer == null) {
      this.countdownTimer = window.setInterval(() => this.render(), 1000);
    } else if (!counting && this.countdownTimer != null) {
      window.clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }

    const viewers =
      state?.participants.filter((participant) => participant.connected && participant.id !== this.selfId).length ?? 0;

    this.ui.showToolbar({
      visible: ready || this.outgoing != null,
      canPresent: ready && this.canPresent && this.outgoing == null && this.dialogMode == null,
      presenting: this.outgoing != null,
      hidden: this.outgoing?.hidden ?? false,
      blurred: this.outgoing?.blurred ?? false,
      canBlur: this.canBlur,
      busy: this.trackChangeInProgress,
      viewers,
    });
  }

  /**
   * One tile per presenter, in the order of the room. The own tile takes the own seat, or comes last while the
   * server has not accepted the presentation yet.
   */
  private tileViews(state: MessageRoomState): TileView[] {
    const tiles: TileView[] = [];
    let ownTileShown = false;

    for (const presenter of state.presenters) {
      if (presenter.participantId === this.selfId) {
        // Without a capture, the own seat is waiting in the resume dialog
        if (this.outgoing != null) {
          tiles.push(this.ownTile());
          ownTileShown = true;
        }

        continue;
      }

      tiles.push(this.remoteTile(state, presenter));
    }

    if (this.outgoing != null && !ownTileShown) {
      tiles.push(this.ownTile());
    }

    return tiles;
  }

  private ownTile(): TileView {
    const outgoing = this.outgoing;

    return {
      key: this.selfId ?? "self",
      name: "",
      self: true,
      stream: outgoing?.previewStream ?? null,
      status: outgoing?.hidden ? "status-self-hidden" : null,
      countdown: null,
    };
  }

  private remoteTile(state: MessageRoomState, presenter: PresenterState): TileView {
    const tile: TileView = {
      key: presenter.participantId,
      name: this.nameOf(presenter.participantId),
      self: false,
      stream: null,
      status: null,
      countdown: null,
    };

    if (presenter.status === "reconnecting") {
      const participant = state.participants.find((participant) => participant.id === presenter.participantId);
      const deadline = this.graceDeadlines.get(presenter.participantId);

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
    tile.stream = this.incoming.get(presenter.streamId)?.mediaStream ?? null;

    if (presenter.hidden) {
      tile.status = "status-presenter-hidden";
    } else if (tile.stream == null) {
      tile.status = "status-joining";
    }

    return tile;
  }

  /**
   * Mutes the other presenters on this page while the own capture may contain this page's sound
   */
  private updateEchoProtection(tiles: TileView[]): void {
    const needed = this.outgoing != null && capturesOwnAudio(this.outgoing.mediaStream);
    this.ui.setEchoMuted(needed);

    if (!needed) {
      this.echoNoticeShown = false;
    } else if (!this.echoNoticeShown && tiles.some((tile) => !tile.self)) {
      this.echoNoticeShown = true;
      this.ui.showNotice("notice-echo-muted");
    }
  }
}

async function main(_event: Event) {
  let isCreator = false;

  if (window.location.hash === "" || window.location.hash === "#") {
    // Put the user in a new room. replaceState does not fire "hashchange", so the page does not reload.
    history.replaceState(null, "", `#${generateRoomName()}`);
    isCreator = true;
  }

  // If the user manually changes the hash, force a reload
  window.onhashchange = (_event: Event) => {
    location.reload();
  };

  if (!("WebSocket" in window)) {
    showPopup("websockets-not-supported");
    return;
  }

  if (!("mediaDevices" in navigator)) {
    showPopup("mediastream-not-supported");
    return;
  }

  if (!("RTCPeerConnection" in window)) {
    showPopup("webrtc-not-supported");
    return;
  }

  const controller = new RoomController(window.location.hash.substring(1), isCreator);
  window.addEventListener("beforeunload", () => controller.close());
  controller.start();
}

window.addEventListener("DOMContentLoaded", main);

/**
 * Generates a random readable room name and returns the words as a string array.
 *
 * @source https://github.com/jitsi/js-utils/blob/master/random/roomNameGenerator.js
 */
function generateRoomName(): string {
  const adjectives = [
    "large",
    "small",
    "beautiful",
    "heavenly",
    "red",
    "yellow",
    "green",
    "orange",
    "purple",
    "massive",
    "tasty",
    "cheap",
    "fancy",
    "expensive",
    "crazy",
    "round",
    "triangular",
    "powered",
    "blue",
    "heavy",
    "square",
    "rectangular",
    "lit",
    "authentic",
    "broken",
    "busy",
    "original",
    "special",
    "thick",
    "thin",
    "pleasant",
    "sharp",
    "steady",
    "happy",
    "delighted",
    "stunning",
  ];

  const pluralNouns = [
    "monsters",
    "people",
    "cars",
    "buttons",
    "vegetables",
    "students",
    "computers",
    "robots",
    "lamps",
    "doors",
    "wizards",
    "books",
    "shirts",
    "pens",
    "guitars",
    "bottles",
    "microphones",
    "pants",
    "drums",
    "plants",
    "batteries",
    "barrels",
    "birds",
    "coins",
    "clothes",
    "deals",
    "crosses",
    "devices",
    "desktops",
    "diamonds",
    "fireworks",
    "funds",
    "guitars",
    "pianos",
    "harmonies",
    "levels",
    "mayors",
    "mechanics",
    "networks",
    "ponds",
    "trees",
    "proofs",
    "flowers",
    "houses",
    "speakers",
    "phones",
    "chargers",
  ];

  const verbs = [
    "break",
    "roll",
    "flip",
    "grow",
    "bake",
    "create",
    "cook",
    "smack",
    "drink",
    "close",
    "display",
    "run",
    "move",
    "flop",
    "wrap",
    "enter",
    "dig",
    "fly",
    "swim",
    "draw",
    "celebrate",
    "communicate",
    "encompass",
    "forgive",
    "negotiate",
    "pioneer",
    "photograph",
    "play",
    "scratch",
    "stabilize",
    "weigh",
    "wrap",
    "yield",
    "return",
    "update",
    "understand",
    "propose",
    "succeed",
    "stretch",
    "submit",
  ];

  const adverbs = [
    "gingerly",
    "thoroughly",
    "heavily",
    "crazily",
    "mostly",
    "fast",
    "slowly",
    "merrily",
    "quickly",
    "heavenly",
    "cheerfully",
    "honestly",
    "politely",
    "bravely",
    "vivaciously",
    "fortunately",
    "innocently",
    "kindly",
    "eagerly",
    "elegantly",
    "vividly",
    "reasonably",
    "rudely",
    "wisely",
    "thankfully",
    "wholly",
    "adorably",
    "happily",
    "firmly",
    "fast",
    "simply",
    "wickedly",
  ];

  const idxAdjective = Math.floor(Math.random() * adjectives.length);
  const idxPluralNoun = Math.floor(Math.random() * pluralNouns.length);
  const idxVerb = Math.floor(Math.random() * verbs.length);
  const idxAdverb = Math.floor(Math.random() * adverbs.length);

  const words = [adjectives[idxAdjective], pluralNouns[idxPluralNoun], verbs[idxVerb], adverbs[idxAdverb]];

  // @see https://flaviocopes.com/how-to-uppercase-first-letter-javascript/
  return words.map((word: string) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
}

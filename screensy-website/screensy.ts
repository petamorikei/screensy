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

type StatusId =
  | "status-connecting"
  | "status-server-reconnecting"
  | "status-waiting"
  | "status-joining"
  | "status-switching"
  | "status-presenter-left"
  | "status-presenter-lost"
  | "status-presenter-resuming"
  | "status-presenter-hidden"
  | "status-self-hidden";

const STATUS_IDS: StatusId[] = [
  "status-connecting",
  "status-server-reconnecting",
  "status-waiting",
  "status-joining",
  "status-switching",
  "status-presenter-left",
  "status-presenter-lost",
  "status-presenter-resuming",
  "status-presenter-hidden",
  "status-self-hidden",
];

type NoticeId =
  | "notice-taken-over"
  | "notice-moved-to-other-tab"
  | "notice-connection-lost"
  | "notice-access-denied"
  | "notice-switch-failed";

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
  return {
    video: { frameRate: { ideal: quality.frameRate } },
    audio: {
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 192000 },
      noiseSuppression: { ideal: false },
      echoCancellation: { ideal: false },
      autoGainControl: { ideal: false },
    },
  };
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

/**
 * A screen capture and the tracks sent from it. The preview shows the same tracks, so that the presenter sees exactly
 * what the viewers get, including the black screen while hidden.
 */
interface Capture {
  stream: MediaStream;
  sendVideo: MediaStreamTrack | null;
  sendAudio: MediaStreamTrack | null;
}

function prepareCapture(stream: MediaStream, hidden: boolean): Capture {
  const capture: Capture = {
    stream,
    sendVideo: stream.getVideoTracks()[0] ?? null,
    sendAudio: stream.getAudioTracks()[0] ?? null,
  };

  // Before the tracks reach any sender, so that a hidden presentation never leaks a frame
  setCaptureHidden(capture, hidden);

  return capture;
}

function setCaptureHidden(capture: Capture, hidden: boolean): void {
  for (const track of [capture.sendVideo, capture.sendAudio]) {
    if (track != null) {
      track.enabled = !hidden;
    }
  }
}

function stopCapture(capture: Capture): void {
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
  ) {
    this.quality = quality;
    this.capture = prepareCapture(mediaStream, false);
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

  get hidden(): boolean {
    return this.isHidden;
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
      stopCapture({ stream: mediaStream, sendVideo: null, sendAudio: null });
      return false;
    }

    const previous = this.capture;
    const next = prepareCapture(mediaStream, this.isHidden);
    this.tuneCapture(next);
    this.pending = next;

    const peers = [...this.peers.values()];
    const results = await Promise.allSettled(
      peers.map(async (peer) => {
        await peer.videoSender.replaceTrack(next.sendVideo);
        await peer.audioSender.replaceTrack(next.sendAudio);
      }),
    );

    this.pending = null;

    if (this.stopped) {
      stopCapture(next);
      return false;
    }

    // A connection that closed meanwhile does not count
    const failed = results.some((result, index) => result.status === "rejected" && this.isOpenPeer(peers[index]));

    if (failed) {
      await Promise.allSettled(
        [...this.peers.values()].map(async (peer) => {
          await peer.videoSender.replaceTrack(previous.sendVideo);
          await peer.audioSender.replaceTrack(previous.sendAudio);
        }),
      );

      stopCapture(next);
      return false;
    }

    this.capture = next;
    stopCapture(previous);

    // Connections opened during the switch still send the previous capture. Reopen them.
    for (const [participantId, peer] of this.peers) {
      if (peer.videoSender.track !== next.sendVideo || peer.audioSender.track !== next.sendAudio) {
        peer.link.close();
        this.peers.delete(participantId);
      }
    }

    if (this.lastSync != null) {
      this.sync(this.lastSync.participants, this.lastSync.selfId);
    }

    // The new capture may have another height, and a sender that had no track, such as the audio of a capture without
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
    const video = capture.sendVideo;

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
    const video = connection.addTransceiver(this.capture.sendVideo ?? "video", options);
    const audio = connection.addTransceiver(this.capture.sendAudio ?? "audio", options);

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
  public onqualitychange: ((quality: QualitySettings) => void) | null = null;
  /**
   * The size of the video changed, for example when the presenter resizes the shared window
   */
  public onvideoresize: (() => void) | null = null;
  /**
   * The name typed in the menu, trimmed. It may be empty.
   */
  public onnamechange: ((name: string) => void) | null = null;
  public onconfirm: ((name: string) => void) | null = null;
  public oncancel: (() => void) | null = null;

  public readonly video: HTMLVideoElement;

  private readonly toolbar: HTMLElement;
  private readonly presentButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly switchButton: HTMLButtonElement;
  private readonly hideButton: HTMLButtonElement;
  private readonly showButton: HTMLButtonElement;
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
    this.video = getElement("stream", HTMLVideoElement);
    this.toolbar = getElement("toolbar", HTMLElement);
    this.presentButton = getElement("present-button", HTMLButtonElement);
    this.stopButton = getElement("stop-button", HTMLButtonElement);
    this.switchButton = getElement("switch-button", HTMLButtonElement);
    this.hideButton = getElement("hide-button", HTMLButtonElement);
    this.showButton = getElement("show-button", HTMLButtonElement);
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

    this.video.addEventListener("resize", () => this.onvideoresize?.());

    // The confirm handler must run synchronously in the submit event, so that getDisplayMedia still has the user
    // activation of the click
    getElement("present-form", HTMLFormElement).addEventListener("submit", (event: SubmitEvent) => {
      event.preventDefault();
      const name = this.nameInput.value.trim();
      this.dialog.close();
      this.onconfirm?.(name);
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

    this.video.onpause = () => {
      if (this.video.srcObject != null) {
        this.video.play().catch(() => {});
      }
    };
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
  showParticipants(participants: { name: string; you: boolean; presenting: boolean; reconnecting: boolean }[]): void {
    const items = participants.map((participant) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.className = "participant-name";
      name.textContent = this.displayName(participant.name);
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
  displayName(name: string | undefined): string {
    return name != null && name !== "" ? name : this.anonymousName;
  }

  setVideo(stream: MediaStream | null, isLocal: boolean): void {
    if (isLocal) {
      // Never play back the presenter's own audio
      this.video.muted = true;
    }

    if (this.video.srcObject !== stream) {
      this.video.srcObject = stream;
    }
  }

  /**
   * @param countdown The time left, shown in the ".countdown" of the status, or null to hide it
   */
  showStatus(id: StatusId | null, name = "", countdown: string | null = null): void {
    for (const statusId of STATUS_IDS) {
      const element = document.getElementById(statusId);

      if (element == null) {
        continue;
      }

      element.classList.toggle("hidden", statusId !== id);

      if (statusId === id) {
        setNameSlots(element, name);

        for (const countdownElement of element.querySelectorAll(".countdown")) {
          countdownElement.classList.toggle("hidden", countdown == null);
        }

        for (const slot of element.querySelectorAll(".countdown-slot")) {
          slot.textContent = countdown ?? "";
        }
      }
    }

    this.status.classList.toggle("hidden", id == null);
  }

  showToolbar(options: {
    visible: boolean;
    canPresent: boolean;
    presenting: boolean;
    hidden: boolean;
    switching: boolean;
    viewers: number;
  }): void {
    this.toolbar.classList.toggle("hidden", !options.visible);
    this.presentButton.classList.toggle("hidden", !options.canPresent);
    this.stopButton.classList.toggle("hidden", !options.presenting);
    this.switchButton.classList.toggle("hidden", !options.presenting);
    this.switchButton.disabled = options.switching;
    this.hideButton.classList.toggle("hidden", !options.presenting || options.hidden);
    this.showButton.classList.toggle("hidden", !options.presenting || !options.hidden);
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
   * @param presenterName The name of the current presenter, who would be taken over, or null
   * @param name The name to fill in
   */
  openDialog(mode: DialogMode, presenterName: string | null, name: string): void {
    for (const element of this.dialog.querySelectorAll<HTMLElement>("[data-mode]")) {
      element.classList.toggle("hidden", element.dataset.mode !== mode);
    }

    const warning = getElement("present-takeover-warning", HTMLElement);
    warning.classList.toggle("hidden", presenterName == null);
    setNameSlots(warning, presenterName ?? "");

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
  private lastShownStreamId: string | null = null;

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
   * From the click on "Switch screen" until the switch is done or abandoned
   */
  private switchInProgress = false;

  private quality: QualitySettings;

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
    this.ui.onconfirm = (name: string) => this.confirmDialog(name);
    this.ui.oncancel = () => this.cancelDialog();
    this.ui.onswitch = () => this.switchScreen();
    this.ui.onhide = (hidden: boolean) => this.setHidden(hidden);
    this.ui.onqualitychange = (quality: QualitySettings) => this.changeQuality(quality);
    this.ui.onvideoresize = () => this.outgoing?.refreshQuality();
    this.ui.onnamechange = (name: string) => this.changeName(name);

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
        if (this.outgoing != null) {
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

    const presenter = this.state?.presenters.find((presenter) => presenter.participantId !== this.selfId);
    const presenterName = presenter == null ? null : this.nameOf(presenter.participantId);

    this.dialogMode = "start";
    this.ui.openDialog("start", presenterName, this.storedName());
    this.render();
  }

  private confirmDialog(name: string): void {
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
      (mediaStream: MediaStream) => this.beginPresenting(mediaStream, name, mode === "resume"),
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

  private beginPresenting(mediaStream: MediaStream, name: string, resume: boolean): void {
    this.outgoing?.stop();

    const outgoing = new OutgoingStream(mediaStream, this.rtcConfig, this.sendMessage, this.quality);
    this.outgoing = outgoing;

    this.watchCapture(outgoing, mediaStream);

    const self = this.state?.participants.find((participant) => participant.id === this.selfId);

    if (self?.name !== name) {
      this.sendMessage({ type: "setname", name });
    }

    // If the socket is down, this message is lost, and the next "welcome" resolves it
    this.sendMessage({ type: "present", resume });
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

    if (outgoing == null || this.switchInProgress) {
      return;
    }

    // Call getDisplayMedia before anything else, while the click still counts as a user activation
    let capture: Promise<MediaStream>;

    try {
      capture = navigator.mediaDevices.getDisplayMedia(displayMediaOptions(this.quality));
    } catch (error) {
      capture = Promise.reject(error);
    }

    this.switchInProgress = true;
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
        this.switchInProgress = false;
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
        name: participant.name,
        you: participant.id === selfId,
        presenting: seats.has(participant.id),
        reconnecting: seats.get(participant.id)?.status === "reconnecting",
      })),
    );
  }

  private changeQuality(quality: QualitySettings): void {
    this.quality = quality;
    writeQuality(quality);
    this.outgoing?.setQuality(quality);
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

  private showSeatLostNotice(): void {
    const presenter = this.state?.presenters.find((presenter) => presenter.participantId !== this.selfId);

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
    return this.ui.displayName(participant?.name);
  }

  /**
   * Updates the video, the status and the toolbar from the current state.
   */
  private render(): void {
    const state = this.state;
    const ready = this.signaling.isOpen && state != null && this.selfId != null;

    let status: StatusId | null = null;
    let statusName = "";
    let countdown: string | null = null;
    let video: MediaStream | null = null;

    if (this.outgoing != null) {
      video = this.outgoing.mediaStream;
    }

    if (!this.signaling.everConnected) {
      status = "status-connecting";
    } else if (!this.signaling.isOpen) {
      status = "status-server-reconnecting";
    } else if (state == null) {
      status = "status-connecting";
    } else if (this.outgoing == null) {
      const presenter = state.presenters.find((presenter) => presenter.participantId !== this.selfId);

      if (presenter == null) {
        status = "status-waiting";
      } else {
        statusName = this.nameOf(presenter.participantId);

        const stream = this.incoming.get(presenter.streamId);

        if (presenter.status === "reconnecting") {
          const participant = state.participants.find((participant) => participant.id === presenter.participantId);
          const deadline = this.graceDeadlines.get(presenter.participantId);

          if (participant?.connected) {
            // Back after a reload, choosing the screen again
            status = "status-presenter-resuming";
          } else {
            status = presenter.disconnectReason === "lost" ? "status-presenter-lost" : "status-presenter-left";
            countdown = deadline == null ? null : formatCountdown(deadline - performance.now());
          }
        } else if (stream?.mediaStream != null) {
          // While hidden, the stream stays attached: it is black and silent
          video = stream.mediaStream;
          this.lastShownStreamId = presenter.streamId;

          if (presenter.hidden) {
            status = "status-presenter-hidden";
          }
        } else if (presenter.hidden) {
          status = "status-presenter-hidden";
        } else if (this.lastShownStreamId != null && this.lastShownStreamId !== presenter.streamId) {
          status = "status-switching";
        } else {
          status = "status-joining";
        }
      }
    } else if (this.outgoing.hidden) {
      status = "status-self-hidden";
    }

    this.ui.setVideo(video, this.outgoing != null);
    this.ui.showStatus(status, statusName, countdown);

    if (countdown != null && this.countdownTimer == null) {
      this.countdownTimer = window.setInterval(() => this.render(), 1000);
    } else if (countdown == null && this.countdownTimer != null) {
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
      switching: this.switchInProgress,
      viewers,
    });
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

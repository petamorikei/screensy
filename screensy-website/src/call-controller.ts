import type { CallState, MessageRoomState, MessageSignalFromServer } from "screensy-protocol";
import type { DeviceChoice, DeviceKind } from "./devices.ts";
import {
  cameraConstraints,
  canChooseSpeaker,
  listDevices,
  microphoneConstraints,
  readDevices,
  writeDevices,
} from "./devices.ts";
import type { IncomingStream } from "./incoming-stream.ts";
import { showNotice } from "./notices.tsx";
import { OutgoingCall } from "./outgoing-call.ts";
import type { MessageSender } from "./signaling.ts";
import { callAtom, devicesAtom, store } from "./state/atoms.ts";
import type { CallMemberView } from "./state/views.ts";
import { statNumber } from "./stats.ts";

/**
 * How often the levels of the call's sound are read, while someone is in the call
 */
const LEVEL_INTERVAL_MS = 300;

/**
 * The level above which a participant counts as speaking, from 0 to 1 (about -34 dBov), as the root mean square of the
 * sound since the previous reading
 */
const SPEAKING_LEVEL = 0.02;

/**
 * How long someone still counts as speaking after the level dropped, so that the mark does not flicker between words
 */
const SPEAKING_HOLD_MS = 600;

const stopTracks = (stream: MediaStream): void => {
  for (const track of stream.getTracks()) {
    track.stop();
  }
};

/**
 * Asks for media in a click handler: getUserMedia must start before anything else, while the click still counts as a
 * user activation
 */
const requestMedia = (constraints: MediaStreamConstraints): Promise<MediaStream> => {
  try {
    return navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    return Promise.reject(error);
  }
};

export interface CallControllerContext {
  readonly sendMessage: MessageSender;
  readonly rtcConfig: () => RTCConfiguration;
  readonly render: () => void;
  /**
   * The latest room state and this client's participant ID, or null before the first ones
   */
  readonly room: () => { state: MessageRoomState; selfId: string } | null;
  readonly incoming: (streamId: string) => IncomingStream | undefined;
}

/**
 * This client's part of the call, in step with the room state: the microphone, the camera, the devices chosen in the
 * menu, and who speaks.
 */
export class CallController {
  public readonly supported: boolean;

  private readonly context: CallControllerContext;
  private call: OutgoingCall | null = null;

  /**
   * "joincall" was sent, and no room state has had this client's call since
   */
  private awaitingCall = false;

  /**
   * Asking for the microphone after a click on "Join call"
   */
  private joining = false;

  /**
   * Asking for the camera after a click on its button
   */
  private requestingCamera = false;

  /**
   * The camera, until the room accepts it: it is not sent before, so that the room never gets more cameras than its
   * limit
   */
  private pendingCamera: MediaStreamTrack | null = null;

  /**
   * The own camera's preview, while it is sent
   */
  private ownCameraStream: MediaStream | null = null;

  private devices: DeviceChoice = readDevices();

  /**
   * Until when each participant counts as speaking, in performance.now() time
   */
  private readonly speakingUntil = new Map<string, number>();

  /**
   * The audio energy and duration of each participant's sound at the previous reading
   */
  private readonly lastEnergy = new Map<string, { energy: number; duration: number }>();
  private speakingIds = "";
  private levelTimer: number | null = null;
  private readingLevels = false;

  constructor(context: CallControllerContext) {
    this.context = context;
    this.supported = "getUserMedia" in navigator.mediaDevices;

    store.set(devicesAtom, (devices) => ({
      ...devices,
      supported: this.supported,
      canChooseSpeaker: canChooseSpeaker(),
      choice: this.devices,
    }));

    if (this.supported) {
      navigator.mediaDevices.addEventListener("devicechange", () => void this.refreshDevices());
      void this.refreshDevices();
    }
  }

  get joined(): boolean {
    return this.call != null;
  }

  get streamId(): string | null {
    return this.call?.streamId ?? null;
  }

  /**
   * The own camera's preview, once the room has accepted it
   */
  get ownCamera(): MediaStream | null {
    return this.ownCameraStream;
  }

  /**
   * The connection to each recipient of the own call, for the statistics
   */
  connections(): { participantId: string; connection: RTCPeerConnection }[] {
    return this.call?.connections() ?? [];
  }

  isSpeaking(participantId: string): boolean {
    return (this.speakingUntil.get(participantId) ?? 0) > performance.now();
  }

  /**
   * The server dropped the call with the old socket. The microphone and the camera are still here, so join again.
   */
  handleWelcome(): void {
    if (this.call != null) {
      this.call.reset();
      this.sendJoin(this.call);
    }
  }

  /**
   * Keeps this client's call as the room state has it: the stream ID and the camera come from there, and a call that
   * the server dropped, for example with a replaced socket, is joined again.
   */
  handleRoomState(state: MessageRoomState, selfId: string): void {
    const own = state.calls.find((call) => call.participantId === selfId);
    const call = this.call;

    if (call == null) {
      if (own != null) {
        this.context.sendMessage({ type: "leavecall" });
      }

      return;
    }

    if (own == null) {
      // Unless the "joincall" is still on its way
      if (!this.awaitingCall) {
        this.sendJoin(call);
      }

      return;
    }

    this.awaitingCall = false;
    call.adopt(own.streamId);

    if (own.camera && this.pendingCamera != null) {
      const track = this.pendingCamera;
      this.pendingCamera = null;
      this.ownCameraStream = new MediaStream([track]);
      void call.setCamera(track);
    }

    call.sync(state.participants, selfId);
  }

  /**
   * Handles a signal of the own call. Returns false for the signals of other streams.
   */
  handleSignal(message: MessageSignalFromServer): boolean {
    if (this.call == null || message.streamId !== this.call.streamId) {
      return false;
    }

    this.call.handleSignal(message).catch((error) => console.warn("Could not handle a signal.", error));
    return true;
  }

  /**
   * The room has reached the limit of cameras: the camera stays off
   */
  handleCameraRejected(): void {
    if (this.cameraWanted) {
      this.stopCamera();
      showNotice("cameras-full");
      this.context.render();
    }
  }

  /**
   * Leaves the call without telling the room, for example when another tab took over this participant
   */
  stop(): void {
    this.stopCamera();
    this.call?.stop();
    this.call = null;
    this.awaitingCall = false;
  }

  /**
   * The buttons and the participants of the call, and the call's sound. The sound keeps playing while the server is
   * away, from the last room state: it goes from browser to browser.
   */
  show(
    ready: boolean,
    nameOf: (participantId: string) => string,
    echo: { echoChoice: boolean; audioMuted: boolean },
  ): void {
    const room = this.context.room();
    const calls = room?.state.calls ?? [];
    const selfId = room?.selfId ?? null;

    const audio = calls.flatMap((call) => {
      const stream = call.participantId === selfId ? null : this.context.incoming(call.streamId)?.mediaStream;
      return stream == null ? [] : [{ key: call.streamId, stream }];
    });

    const members: CallMemberView[] = ready
      ? calls.map((call) => ({
          id: call.participantId,
          name: nameOf(call.participantId),
          muted: call.muted,
          camera: call.camera,
          speaking: this.isSpeaking(call.participantId),
        }))
      : [];

    store.set(callAtom, {
      ready,
      supported: this.supported,
      joined: this.call != null,
      joining: this.joining,
      muted: this.call?.muted ?? false,
      camera: this.cameraWanted,
      cameraBusy: this.requestingCamera || this.pendingCamera != null,
      members,
      audio,
      audioMuted: echo.audioMuted,
      echoChoice: echo.echoChoice,
    });

    this.updateLevelTimer(calls);
  }

  /**
   * Refreshes the lists of devices, whose names the browser shows once the page may use them
   */
  async refreshDevices(): Promise<void> {
    if (!this.supported) {
      return;
    }

    try {
      const lists = await listDevices();
      store.set(devicesAtom, (devices) => ({ ...devices, lists, choice: this.devices }));
    } catch (error) {
      console.warn("Could not list the devices.", error);
    }
  }

  /**
   * Whether the camera is on, or being turned on
   */
  private get cameraWanted(): boolean {
    return this.pendingCamera != null || this.call?.cameraTrack != null;
  }

  private sendJoin(call: OutgoingCall): void {
    // If the socket is down, this message is lost, and the next "welcome" sends it again
    this.context.sendMessage({ type: "joincall", muted: call.muted, camera: this.cameraWanted });
    this.awaitingCall = true;
  }

  private sendCallState(): void {
    if (this.call != null) {
      this.context.sendMessage({ type: "callstate", muted: this.call.muted, camera: this.cameraWanted });
    }
  }

  /**
   * Asks for the microphone and joins the call. Must be called in the handler of the click on "Join call".
   */
  join(): void {
    if (this.call != null || this.joining || !this.supported) {
      return;
    }

    const microphone = requestMedia(microphoneConstraints(this.devices));
    this.joining = true;
    this.context.render();

    microphone.then(
      (mediaStream: MediaStream) => {
        this.joining = false;
        const track = mediaStream.getAudioTracks()[0] ?? null;
        const call = new OutgoingCall(track, this.context.rtcConfig, this.context.sendMessage);
        this.call = call;

        if (track != null) {
          this.watchMicrophone(call, track);
        }

        this.sendJoin(call);
        this.context.render();
        void this.refreshDevices();
      },
      () => {
        this.joining = false;
        showNotice("microphone-denied");
        this.context.render();
      },
    );
  }

  /**
   * Leaves the call when the microphone ends, for example when it is unplugged
   */
  private watchMicrophone(call: OutgoingCall, track: MediaStreamTrack): void {
    track.addEventListener("ended", () => {
      if (this.call === call && call.microphoneTrack === track) {
        this.leave();
      }
    });
  }

  leave(): void {
    if (this.call == null) {
      return;
    }

    this.context.sendMessage({ type: "leavecall" });
    this.stop();
    this.context.render();
  }

  setMuted(muted: boolean): void {
    if (this.call == null) {
      return;
    }

    this.call.setMuted(muted);
    this.sendCallState();
    this.context.render();
  }

  /**
   * Turns the camera on or off. On, the camera is only sent once the room accepts it.
   */
  setCamera(on: boolean): void {
    const call = this.call;

    if (call == null) {
      return;
    }

    if (!on) {
      this.stopCamera();
      this.sendCallState();
      this.context.render();
      return;
    }

    if (this.requestingCamera || this.cameraWanted) {
      return;
    }

    const camera = requestMedia(cameraConstraints(this.devices));
    this.requestingCamera = true;
    this.context.render();

    camera.then(
      (stream: MediaStream) => {
        this.requestingCamera = false;
        const track = stream.getVideoTracks()[0];

        if (this.call !== call || track == null) {
          // Left the call meanwhile
          stopTracks(stream);
          this.context.render();
          return;
        }

        this.watchCamera(track);
        this.pendingCamera = track;
        this.sendCallState();
        this.context.render();
        void this.refreshDevices();
      },
      () => {
        this.requestingCamera = false;
        showNotice("camera-denied");
        this.context.render();
      },
    );
  }

  /**
   * Turns the camera off when it ends, for example when it is unplugged
   */
  private watchCamera(track: MediaStreamTrack): void {
    track.contentHint = "motion";
    track.addEventListener("ended", () => {
      if (this.pendingCamera === track || this.call?.cameraTrack === track) {
        this.stopCamera();
        this.sendCallState();
        this.context.render();
      }
    });
  }

  /**
   * Stops the camera, so that its light goes off, and sends no video
   */
  private stopCamera(): void {
    this.pendingCamera?.stop();
    this.pendingCamera = null;
    this.ownCameraStream = null;

    const track = this.call?.cameraTrack;

    if (track != null) {
      void this.call?.setCamera(null);
      track.stop();
    }
  }

  changeDevice(kind: DeviceKind, deviceId: string): void {
    this.devices = { ...this.devices, [kind]: deviceId };
    writeDevices(this.devices);
    // The speaker applies where the page plays: the stage and the call
    store.set(devicesAtom, (devices) => ({ ...devices, choice: this.devices }));

    if (kind === "microphone") {
      void this.replaceMicrophone();
    } else if (kind === "camera") {
      void this.replaceCamera();
    }
  }

  /**
   * Sends the chosen microphone instead of the current one, on the same connections
   */
  private async replaceMicrophone(): Promise<void> {
    const call = this.call;

    if (call == null) {
      return;
    }

    let stream: MediaStream;

    try {
      stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(this.devices));
    } catch {
      showNotice("microphone-denied");
      return;
    }

    const track = stream.getAudioTracks()[0];

    if (this.call !== call || track == null) {
      stopTracks(stream);
      return;
    }

    this.watchMicrophone(call, track);
    await call.replaceMicrophone(track);
    void this.refreshDevices();
  }

  /**
   * Sends the chosen camera instead of the current one, if the camera is on
   */
  private async replaceCamera(): Promise<void> {
    const call = this.call;
    const previous = call?.cameraTrack;

    if (call == null || previous == null) {
      return;
    }

    let stream: MediaStream;

    try {
      stream = await navigator.mediaDevices.getUserMedia(cameraConstraints(this.devices));
    } catch {
      showNotice("camera-denied");
      return;
    }

    const track = stream.getVideoTracks()[0];

    // The camera may have been turned off meanwhile
    if (this.call !== call || call.cameraTrack !== previous || track == null) {
      stopTracks(stream);
      return;
    }

    this.watchCamera(track);
    this.ownCameraStream = new MediaStream([track]);
    await call.setCamera(track);
    previous.stop();
    this.context.render();
    void this.refreshDevices();
  }

  /**
   * Reads the levels while someone is in the call
   */
  private updateLevelTimer(calls: CallState[]): void {
    const needed = calls.length > 0;

    if (needed && this.levelTimer == null) {
      this.levelTimer = window.setInterval(() => void this.readLevels(), LEVEL_INTERVAL_MS);
    } else if (!needed && this.levelTimer != null) {
      window.clearInterval(this.levelTimer);
      this.levelTimer = null;
      this.speakingUntil.clear();
      this.lastEnergy.clear();
      this.speakingIds = "";
    }
  }

  /**
   * Marks who speaks: the received sound of the others, and the own microphone as the own connections send it.
   * Renders only when that changes.
   */
  private async readLevels(): Promise<void> {
    const room = this.context.room();

    if (room == null || this.readingLevels) {
      return;
    }

    this.readingLevels = true;

    try {
      const now = performance.now();

      for (const call of room.state.calls) {
        if (call.muted) {
          this.speakingUntil.delete(call.participantId);
          continue;
        }

        const connection =
          call.participantId === room.selfId
            ? this.call?.connections()[0]?.connection
            : this.context.incoming(call.streamId)?.connection;
        const level =
          connection == null
            ? null
            : await this.levelSince(call.participantId, connection, call.participantId === room.selfId);

        if (level != null && level > SPEAKING_LEVEL) {
          this.speakingUntil.set(call.participantId, now + SPEAKING_HOLD_MS);
        }
      }

      const speakingIds = room.state.calls
        .filter((call) => this.isSpeaking(call.participantId))
        .map((call) => call.participantId)
        .join(",");

      if (speakingIds !== this.speakingIds) {
        this.speakingIds = speakingIds;
        this.context.render();
      }
    } finally {
      this.readingLevels = false;
    }
  }

  /**
   * The level of a participant's sound since the previous reading, from the audio energy in the statistics: the own
   * microphone as one of the own connections sends it, or the sound received from someone else. Unlike the level of the
   * moment, it does not miss a short sound between two readings.
   */
  private async levelSince(participantId: string, connection: RTCPeerConnection, own: boolean): Promise<number | null> {
    const type = own ? "media-source" : "inbound-rtp";
    let energy: number | null = null;
    let duration: number | null = null;

    (await connection.getStats()).forEach((entry: Record<string, unknown>) => {
      if (entry.type === type && entry.kind === "audio") {
        energy = statNumber(entry, "totalAudioEnergy");
        duration = statNumber(entry, "totalSamplesDuration");
      }
    });

    if (energy == null || duration == null) {
      return null;
    }

    const last = this.lastEnergy.get(participantId);
    this.lastEnergy.set(participantId, { energy, duration });

    if (last == null || duration <= last.duration || energy < last.energy) {
      return null;
    }

    return Math.sqrt((energy - last.energy) / (duration - last.duration));
  }
}

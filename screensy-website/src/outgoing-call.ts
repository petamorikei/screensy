import type { MessageSignalFromServer, ParticipantState } from "screensy-protocol";
import { OutgoingPeers } from "./outgoing-peers.ts";
import type { MessageSender } from "./signaling.ts";

/**
 * The microphone constraints of the call: the echo canceller removes the call's sound from the speakers
 */
export const MICROPHONE_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/**
 * The camera constraints of the call: small, because everyone sends it to everyone, next to the screens
 */
export const CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 640 },
  height: { ideal: 360 },
  frameRate: { ideal: 24 },
};

interface CallSenders {
  readonly audio: RTCRtpSender;
  readonly video: RTCRtpSender;
}

/**
 * This client's part of the call: the microphone, and the camera while it is on, sent to every other connected
 * participant, whether they are in the call or not. The server gives it a stream ID in the room state; until then it has
 * no connections.
 *
 * Every connection has one audio and one video transceiver. Muting only disables the microphone track, so that it
 * sends silence, and the camera replaces the video track: neither negotiates again.
 */
export class OutgoingCall {
  private microphone: MediaStreamTrack | null;
  private camera: MediaStreamTrack | null = null;

  /**
   * Gives the transceivers a stream to announce, which stays the same when the tracks change
   */
  private readonly sendStream = new MediaStream();
  private readonly peers: OutgoingPeers<CallSenders>;
  private currentStreamId: string | null = null;
  private isMuted = false;

  constructor(microphone: MediaStreamTrack | null, rtcConfig: () => RTCConfiguration, sendMessage: MessageSender) {
    this.microphone = microphone;
    const options: RTCRtpTransceiverInit = { direction: "sendonly", streams: [this.sendStream] };
    this.peers = new OutgoingPeers(rtcConfig, sendMessage, (connection) => ({
      audio: connection.addTransceiver(this.microphone ?? "audio", options).sender,
      video: connection.addTransceiver(this.camera ?? "video", options).sender,
    }));
  }

  get streamId(): string | null {
    return this.currentStreamId;
  }

  get muted(): boolean {
    return this.isMuted;
  }

  get microphoneTrack(): MediaStreamTrack | null {
    return this.microphone;
  }

  /**
   * The camera track that is sent, or null while the camera is off
   */
  get cameraTrack(): MediaStreamTrack | null {
    return this.camera;
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted;

    if (this.microphone != null) {
      this.microphone.enabled = !muted;
    }
  }

  /**
   * Sends another microphone, for example one chosen in the menu, and stops the previous one. The mute state stays.
   */
  async replaceMicrophone(track: MediaStreamTrack): Promise<void> {
    const previous = this.microphone;
    track.enabled = !this.isMuted;
    this.microphone = track;
    await Promise.allSettled([...this.peers.values()].map((peer) => peer.senders.audio.replaceTrack(track)));
    previous?.stop();
  }

  /**
   * Sends the camera, or no video with null. The caller stops the previous track.
   */
  async setCamera(track: MediaStreamTrack | null): Promise<void> {
    this.camera = track;
    await Promise.allSettled([...this.peers.values()].map((peer) => peer.senders.video.replaceTrack(track)));
  }

  /**
   * Takes the stream ID that the room state gives this client's call. A new one replaces every connection.
   */
  adopt(streamId: string): void {
    if (streamId !== this.currentStreamId) {
      this.peers.closeAll();
      this.currentStreamId = streamId;
    }
  }

  sync(participants: ParticipantState[], selfId: string): void {
    if (this.currentStreamId != null) {
      this.peers.sync(participants, selfId, this.currentStreamId);
    }
  }

  async handleSignal(message: MessageSignalFromServer): Promise<void> {
    if (message.streamId === this.currentStreamId) {
      await this.peers.handleSignal(message);
    }
  }

  /**
   * Closes the connections until the room state gives a new stream ID. The microphone and the camera keep running.
   */
  reset(): void {
    this.peers.closeAll();
    this.currentStreamId = null;
  }

  stop(): void {
    this.reset();
    this.microphone?.stop();
    this.camera?.stop();
  }

  /**
   * The connection to each recipient, for the statistics and the own audio level
   */
  connections(): { participantId: string; connection: RTCPeerConnection }[] {
    return [...this.peers.entries()].map(([participantId, peer]) => ({
      participantId,
      connection: peer.link.connection,
    }));
  }
}

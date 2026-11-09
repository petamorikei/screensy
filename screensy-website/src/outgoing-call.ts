import type { MessageSignalFromServer, ParticipantState } from "screensy-protocol";
import { OutgoingPeers } from "./outgoing-peers.ts";
import type { MessageSender } from "./signaling.ts";

/**
 * The microphone constraints of the call: the echo canceller removes the call's sound from the speakers
 */
export const MICROPHONE_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

/**
 * This client's part of the voice call: the microphone, sent to every other connected participant, whether they are in
 * the call or not. The server gives it a stream ID in the room state; until then it has no connections.
 *
 * Every connection has one audio transceiver, which keeps the microphone track while muted: muting only disables it,
 * so that it sends silence, without a new negotiation.
 */
export class OutgoingCall {
  public readonly mediaStream: MediaStream;
  private readonly track: MediaStreamTrack | null;
  private readonly peers: OutgoingPeers<RTCRtpSender>;
  private currentStreamId: string | null = null;
  private isMuted = false;

  constructor(mediaStream: MediaStream, rtcConfig: () => RTCConfiguration, sendMessage: MessageSender) {
    this.mediaStream = mediaStream;
    this.track = mediaStream.getAudioTracks()[0] ?? null;
    this.peers = new OutgoingPeers(
      rtcConfig,
      sendMessage,
      (connection) =>
        connection.addTransceiver(this.track ?? "audio", { direction: "sendonly", streams: [mediaStream] }).sender,
    );
  }

  get streamId(): string | null {
    return this.currentStreamId;
  }

  get muted(): boolean {
    return this.isMuted;
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted;

    if (this.track != null) {
      this.track.enabled = !muted;
    }
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
   * Closes the connections until the room state gives a new stream ID. The microphone keeps running.
   */
  reset(): void {
    this.peers.closeAll();
    this.currentStreamId = null;
  }

  stop(): void {
    this.reset();

    for (const track of this.mediaStream.getTracks()) {
      track.stop();
    }
  }
}

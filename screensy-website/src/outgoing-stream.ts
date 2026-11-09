import type { MessageSignalFromServer, ParticipantState } from "screensy-protocol";
import { BlurProcessor } from "./blur.ts";
import type { Capture } from "./capture.ts";
import { prepareCapture, sentVideo, setTrackStates, stopCapture } from "./capture.ts";
import type { OutgoingPeer } from "./outgoing-peers.ts";
import { OutgoingPeers } from "./outgoing-peers.ts";
import type { QualitySettings } from "./quality.ts";
import { applyQuality, contentHintFor } from "./quality.ts";
import type { MessageSender } from "./signaling.ts";

interface ScreenSenders {
  readonly video: RTCRtpSender;
  readonly audio: RTCRtpSender;
  /**
   * The last setParameters of this connection. They run one after the other, because each one needs the parameters
   * that the previous one set.
   */
  applyingQuality: Promise<void>;
}

/**
 * The screen this client presents. It has one connection per recipient, keyed by participant ID and connection ID.
 * Until the server accepts the presentation, it has no stream ID and no connections.
 *
 * Every connection has one video and one audio transceiver, even for a capture without audio. Switching the screen
 * or hiding it then only replaces or disables tracks, without a new negotiation.
 */
export class OutgoingStream {
  private readonly sendMessage: MessageSender;
  private readonly peers: OutgoingPeers<ScreenSenders>;
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
   * Whether a capture's sound must not be sent, because it may carry the call back to the room (see
   * RoomController.screenAudioSuppressed). Asked again by refreshTrackStates.
   */
  private readonly audioSuppressed: (stream: MediaStream) => boolean;

  /**
   * The participants of the last sync, to reopen connections after a switch
   */
  private lastSync: { participants: ParticipantState[]; selfId: string } | null = null;

  private quality: QualitySettings;

  constructor(
    mediaStream: MediaStream,
    rtcConfig: () => RTCConfiguration,
    sendMessage: MessageSender,
    quality: QualitySettings,
    blurStrength: number,
    audioSuppressed: (stream: MediaStream) => boolean,
  ) {
    this.quality = quality;
    this.blurStrength = blurStrength;
    this.audioSuppressed = audioSuppressed;
    this.capture = prepareCapture(mediaStream, null);
    this.applyTrackStates(this.capture);
    this.tuneCapture(this.capture);
    this.sendMessage = sendMessage;

    const options: RTCRtpTransceiverInit = { direction: "sendonly", streams: [this.sendStream] };
    this.peers = new OutgoingPeers(rtcConfig, sendMessage, (connection) => ({
      video: connection.addTransceiver(sentVideo(this.capture) ?? "video", options).sender,
      audio: connection.addTransceiver(this.capture.audio ?? "audio", options).sender,
      applyingQuality: Promise.resolve(),
    }));
    this.peers.onicecomplete = (peer) => this.queueQuality(peer);
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
    this.refreshTrackStates();
    this.sendStreamState();
  }

  /**
   * Asks again whether the sound of the current capture, and of one being switched to, may be sent
   */
  refreshTrackStates(): void {
    this.applyTrackStates(this.capture);

    if (this.pending != null) {
      this.applyTrackStates(this.pending);
    }
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
      next = prepareCapture(mediaStream, this.isBlurred ? this.blurStrength : null);
    } catch (error) {
      console.warn("Could not prepare the new capture.", error);

      for (const track of mediaStream.getTracks()) {
        track.stop();
      }

      return false;
    }

    this.applyTrackStates(next);
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
    this.applyTrackStates(next);

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
        await peer.senders.video.replaceTrack(sentVideo(next));
        await peer.senders.audio.replaceTrack(next.audio);
      }),
    );

    this.pending = null;

    if (this.stopped) {
      discard();
      return false;
    }

    // A connection that closed meanwhile does not count
    const failed = results.some((result, index) => result.status === "rejected" && this.peers.isOpen(peers[index]));

    if (failed) {
      await Promise.allSettled(
        [...this.peers.values()].map(async (peer) => {
          await peer.senders.video.replaceTrack(sentVideo(previous));
          await peer.senders.audio.replaceTrack(previous.audio);
        }),
      );

      discard();
      return false;
    }

    this.capture = next;
    release(previous);

    // Connections opened during the change still send the previous tracks. Reopen them.
    for (const [participantId, peer] of [...this.peers.entries()]) {
      if (peer.senders.video.track !== sentVideo(next) || peer.senders.audio.track !== next.audio) {
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
    this.peers.closeAll();
    this.currentStreamId = null;
  }

  /**
   * Adopts the stream ID from "presentaccepted". Connections are rebuilt on the next sync.
   */
  adopt(streamId: string): void {
    this.peers.closeAll();
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
   * Stops the capture and closes every connection.
   */
  stop(): void {
    // A switch in progress sees this and stops its new capture
    this.stopped = true;
    this.peers.closeAll();
    this.currentStreamId = null;
    stopCapture(this.capture);
  }

  private applyTrackStates(capture: Capture): void {
    setTrackStates(capture, this.isHidden, this.audioSuppressed(capture.stream));
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
    return [...this.peers.entries()].map(([participantId, peer]) => ({
      participantId,
      connection: peer.link.connection,
    }));
  }

  private queueQuality(peer: OutgoingPeer<ScreenSenders>): void {
    peer.senders.applyingQuality = peer.senders.applyingQuality.then(() =>
      applyQuality(peer.link.connection, this.quality),
    );
  }

  private sendStreamState(): void {
    if (this.currentStreamId != null) {
      this.sendMessage({ type: "streamstate", streamId: this.currentStreamId, hidden: this.isHidden });
    }
  }
}

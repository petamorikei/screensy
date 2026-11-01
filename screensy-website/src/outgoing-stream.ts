import type { MessageSignalFromServer, ParticipantState } from "screensy-protocol";
import { BlurProcessor } from "./blur.ts";
import type { Capture } from "./capture.ts";
import { prepareCapture, sentVideo, setCaptureHidden, stopCapture } from "./capture.ts";
import { PeerLink } from "./peer-link.ts";
import type { QualitySettings } from "./quality.ts";
import { applyQuality, contentHintFor } from "./quality.ts";
import type { MessageSender } from "./signaling.ts";

export interface OutgoingPeer {
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
 * The screen this client presents. It has one connection per recipient, keyed by participant ID and connection ID.
 * Until the server accepts the presentation, it has no stream ID and no connections.
 *
 * Every connection has one video and one audio transceiver, even for a capture without audio. Switching the screen
 * or hiding it then only replaces or disables tracks, without a new negotiation.
 */
export class OutgoingStream {
  /**
   * The configuration for a new connection, which changes with every "welcome"
   */
  private readonly rtcConfig: () => RTCConfiguration;
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
    rtcConfig: () => RTCConfiguration,
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
    const link = new PeerLink(this.rtcConfig());
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

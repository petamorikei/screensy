import type { MessageSignalFromServer, ParticipantState } from "screensy-protocol";
import { PeerLink } from "./peer-link.ts";
import type { MessageSender } from "./signaling.ts";

/**
 * The connection to one recipient of a stream, and what the stream sends on it
 */
export interface OutgoingPeer<S> {
  readonly connectionId: string;
  readonly link: PeerLink;
  readonly senders: S;
}

/**
 * The connections of a stream that this client sends: one per recipient, keyed by participant ID and connection ID.
 * This side sends the offers. The stream decides what each connection sends (addSenders), before the offer.
 */
export class OutgoingPeers<S> {
  /**
   * A connection finished gathering its ICE candidates
   */
  public onicecomplete: ((peer: OutgoingPeer<S>) => void) | null = null;

  /**
   * The configuration for a new connection, which changes with every "welcome"
   */
  private readonly rtcConfig: () => RTCConfiguration;
  private readonly sendMessage: MessageSender;
  private readonly addSenders: (connection: RTCPeerConnection) => S;
  private readonly peers = new Map<string, OutgoingPeer<S>>();

  constructor(
    rtcConfig: () => RTCConfiguration,
    sendMessage: MessageSender,
    addSenders: (connection: RTCPeerConnection) => S,
  ) {
    this.rtcConfig = rtcConfig;
    this.sendMessage = sendMessage;
    this.addSenders = addSenders;
  }

  /**
   * Opens a connection to every other connected participant and closes the connections to participants that left or
   * reconnected.
   */
  sync(participants: ParticipantState[], selfId: string, streamId: string): void {
    const recipients = new Map<string, string>();

    for (const participant of participants) {
      if (participant.connected && participant.id !== selfId) {
        recipients.set(participant.id, participant.connectionId);
      }
    }

    for (const [participantId, peer] of this.peers) {
      if (recipients.get(participantId) !== peer.connectionId) {
        this.delete(participantId);
      }
    }

    for (const [participantId, connectionId] of recipients) {
      if (!this.peers.has(participantId)) {
        this.add(participantId, connectionId, streamId);
      }
    }
  }

  /**
   * Handles an answer or an ICE candidate of the stream's current connections. The caller checks the stream ID.
   */
  async handleSignal(message: MessageSignalFromServer): Promise<void> {
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

  values(): IterableIterator<OutgoingPeer<S>> {
    return this.peers.values();
  }

  entries(): IterableIterator<[string, OutgoingPeer<S>]> {
    return this.peers.entries();
  }

  /**
   * Whether the peer is still one of the connections, and not closed
   */
  isOpen(peer: OutgoingPeer<S>): boolean {
    return [...this.peers.values()].includes(peer) && peer.link.connection.connectionState !== "closed";
  }

  /**
   * Closes the connection to the participant. The next sync opens a new one.
   */
  delete(participantId: string): void {
    this.peers.get(participantId)?.link.close();
    this.peers.delete(participantId);
  }

  closeAll(): void {
    for (const peer of this.peers.values()) {
      peer.link.close();
    }

    this.peers.clear();
  }

  private add(participantId: string, connectionId: string, streamId: string): void {
    const link = new PeerLink(this.rtcConfig());
    const connection = link.connection;
    const peer: OutgoingPeer<S> = { connectionId, link, senders: this.addSenders(connection) };

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
        this.onicecomplete?.(peer);
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

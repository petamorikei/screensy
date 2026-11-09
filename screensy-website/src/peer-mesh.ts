import type { MessageMeshSignalFromServer, ParticipantState } from "screensy-protocol";
import { PeerLink } from "./peer-link.ts";
import type { MessageSender } from "./signaling.ts";

/**
 * The data channel of the chat. Both sides create it with this ID (negotiated), so that neither waits for the other
 * to announce it.
 */
const CHAT_CHANNEL_ID = 0;

/**
 * The data channel of the files, beside the chat, so that a large file never holds up the chat messages
 */
const FILES_CHANNEL_ID = 1;

/**
 * How long the offering side waits before it rebuilds a connection that failed, and how often it tries. Without a
 * TURN relay, two browsers without a direct path never connect, so it gives up until one of them reconnects.
 */
const RETRY_DELAY_MS = 5000;
const MAX_ATTEMPTS = 3;

/**
 * The largest message to send when the connection does not tell its own limit, and the largest one to send at all:
 * 16 KiB goes through every browser.
 */
const DEFAULT_MAX_MESSAGE_SIZE = 16 * 1024;
const MAX_MESSAGE_SIZE = 64 * 1024;

interface MeshPeer {
  connectionId: string;
  link: PeerLink;
  channel: RTCDataChannel;
  files: RTCDataChannel;
  /**
   * Whether onopen was reported, so that onclose is reported once and only after it
   */
  open: boolean;
}

/**
 * The connections without media between this client and every other connected participant, for the chat and the
 * files. Each pair has one connection, keyed by participant ID and connection ID like the streams: a new connection ID
 * rebuilds it. Of the two sides, the one with the greater connection ID (compared as strings: any order on which both
 * sides agree will do) sends the offer.
 */
export class PeerMesh {
  public onopen: ((peerId: string) => void) | null = null;
  public onclose: ((peerId: string) => void) | null = null;
  public onmessage: ((peerId: string, data: string) => void) | null = null;
  /**
   * The files channel to a participant opened
   */
  public onfilesopen: ((peerId: string) => void) | null = null;
  public onfilesmessage: ((peerId: string, data: string | ArrayBuffer) => void) | null = null;

  private readonly rtcConfig: () => RTCConfiguration;
  private readonly sendMessage: MessageSender;
  private readonly peers = new Map<string, MeshPeer>();

  /**
   * The other connected participants of the last sync: participant ID to connection ID
   */
  private targets = new Map<string, string>();
  private selfConnectionId: string | null = null;

  /**
   * The failed attempts per participant, for its current connection ID
   */
  private readonly failures = new Map<string, { connectionId: string; count: number }>();
  private readonly retryTimers = new Map<string, number>();

  /**
   * @param rtcConfig The configuration for a new connection, which changes with every "welcome"
   */
  constructor(rtcConfig: () => RTCConfiguration, sendMessage: MessageSender) {
    this.rtcConfig = rtcConfig;
    this.sendMessage = sendMessage;
  }

  /**
   * Connects to the other connected participants, and closes the connections to those who left or reconnected
   */
  sync(participants: ParticipantState[], selfId: string, selfConnectionId: string): void {
    this.selfConnectionId = selfConnectionId;
    this.targets = new Map(
      participants
        .filter((participant) => participant.connected && participant.id !== selfId)
        .map((participant) => [participant.id, participant.connectionId]),
    );

    for (const [peerId, peer] of this.peers) {
      if (this.targets.get(peerId) !== peer.connectionId) {
        this.closePeer(peerId);
      }
    }

    for (const [peerId, failure] of this.failures) {
      if (this.targets.get(peerId) !== failure.connectionId) {
        this.failures.delete(peerId);
        this.clearRetry(peerId);
      }
    }

    for (const [peerId, connectionId] of this.targets) {
      if (!this.peers.has(peerId) && !this.retryTimers.has(peerId) && this.shouldConnect(peerId, connectionId)) {
        this.addPeer(peerId, connectionId, true);
      }
    }
  }

  async handleSignal(message: MessageMeshSignalFromServer): Promise<void> {
    const peerId = message.from;
    const connectionId = message.fromConnection;

    if (this.targets.get(peerId) !== connectionId) {
      // A signal of an old connection, or of someone that the latest room state does not have yet
      return;
    }

    switch (message.kind) {
      case "offer": {
        if (this.isOfferer(connectionId)) {
          return;
        }

        // Every offer starts a new connection: the other side rebuilt its own, for example after a failure
        this.closePeer(peerId);
        const peer = this.addPeer(peerId, connectionId, false);
        const connection = peer.link.connection;
        await peer.link.setRemoteDescription(message.message);
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);

        const localDescription = connection.localDescription;

        if (localDescription == null || this.peers.get(peerId) !== peer) {
          return;
        }

        this.sendMessage({
          type: "meshsignal",
          to: peerId,
          toConnection: connectionId,
          kind: "answer",
          message: localDescription.toJSON(),
        });
        break;
      }
      case "answer": {
        const peer = this.peers.get(peerId);

        if (peer?.connectionId === connectionId && this.isOfferer(connectionId)) {
          await peer.link.setRemoteDescription(message.message);
        }

        break;
      }
      case "candidate": {
        const peer = this.peers.get(peerId);

        if (peer?.connectionId === connectionId) {
          await peer.link.addIceCandidate(message.message);
        }

        break;
      }
    }
  }

  /**
   * Sends a message on the chat channel. Returns false if the channel is not open.
   */
  send(peerId: string, data: string): boolean {
    const peer = this.peers.get(peerId);

    if (peer?.channel.readyState !== "open") {
      return false;
    }

    try {
      peer.channel.send(data);
      return true;
    } catch (error) {
      console.warn("Could not send on the data channel.", error);
      return false;
    }
  }

  /**
   * The open files channel to a participant, or null
   */
  filesChannel(peerId: string): RTCDataChannel | null {
    const channel = this.peers.get(peerId)?.files;
    return channel?.readyState === "open" ? channel : null;
  }

  /**
   * The participants whose chat channel is open
   */
  openPeers(): string[] {
    return [...this.peers].filter(([, peer]) => peer.channel.readyState === "open").map(([peerId]) => peerId);
  }

  /**
   * The number of other connected participants
   */
  get targetCount(): number {
    return this.targets.size;
  }

  /**
   * The largest message, in bytes, that the connection to the participant takes
   */
  maxMessageSize(peerId: string): number {
    const size = this.peers.get(peerId)?.link.connection.sctp?.maxMessageSize;

    // Infinity and 0 both mean "no limit"
    return size == null || size <= 0 ? DEFAULT_MAX_MESSAGE_SIZE : Math.min(size, MAX_MESSAGE_SIZE);
  }

  /**
   * Closes every connection, for example when this client's own connection ID changed
   */
  reset(): void {
    for (const peerId of [...this.peers.keys()]) {
      this.closePeer(peerId);
    }

    for (const peerId of [...this.retryTimers.keys()]) {
      this.clearRetry(peerId);
    }

    this.failures.clear();
    this.targets.clear();
    this.selfConnectionId = null;
  }

  private isOfferer(peerConnectionId: string): boolean {
    return this.selfConnectionId != null && this.selfConnectionId > peerConnectionId;
  }

  private shouldConnect(peerId: string, connectionId: string): boolean {
    const failure = this.failures.get(peerId);
    return this.isOfferer(connectionId) && (failure?.connectionId !== connectionId || failure.count < MAX_ATTEMPTS);
  }

  private addPeer(peerId: string, connectionId: string, offerer: boolean): MeshPeer {
    const link = new PeerLink(this.rtcConfig());
    const connection = link.connection;
    const channel = connection.createDataChannel("chat", { negotiated: true, id: CHAT_CHANNEL_ID });
    const files = connection.createDataChannel("files", { negotiated: true, id: FILES_CHANNEL_ID });
    files.binaryType = "arraybuffer";
    const peer: MeshPeer = { connectionId, link, channel, files, open: false };
    const current = () => this.peers.get(peerId) === peer;

    this.peers.set(peerId, peer);

    channel.onopen = () => {
      if (current()) {
        peer.open = true;
        this.failures.delete(peerId);
        this.onopen?.(peerId);
      }
    };

    channel.onclose = () => {
      if (current()) {
        this.closePeer(peerId);
      }
    };

    channel.onmessage = (event: MessageEvent) => {
      if (current() && typeof event.data === "string") {
        this.onmessage?.(peerId, event.data);
      }
    };

    files.onopen = () => {
      if (current()) {
        this.onfilesopen?.(peerId);
      }
    };

    files.onmessage = (event: MessageEvent) => {
      if (current() && (typeof event.data === "string" || event.data instanceof ArrayBuffer)) {
        this.onfilesmessage?.(peerId, event.data);
      }
    };

    connection.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate == null || !current()) {
        return;
      }

      this.sendMessage({
        type: "meshsignal",
        to: peerId,
        toConnection: connectionId,
        kind: "candidate",
        message: event.candidate.toJSON(),
      });
    };

    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "failed" && current()) {
        this.handleFailure(peerId, connectionId, offerer);
      }
    };

    if (offerer) {
      void this.sendOffer(peer, peerId);
    }

    return peer;
  }

  private async sendOffer(peer: MeshPeer, peerId: string): Promise<void> {
    const connection = peer.link.connection;

    try {
      await connection.setLocalDescription(await connection.createOffer());
    } catch (error) {
      console.warn("Could not create an offer for the mesh.", error);
      return;
    }

    const localDescription = connection.localDescription;

    // The connection may have been closed while the offer was created
    if (localDescription == null || this.peers.get(peerId) !== peer) {
      return;
    }

    this.sendMessage({
      type: "meshsignal",
      to: peerId,
      toConnection: peer.connectionId,
      kind: "offer",
      message: localDescription.toJSON(),
    });
  }

  /**
   * Closes a failed connection. The offering side builds a new one after a while, up to MAX_ATTEMPTS times.
   */
  private handleFailure(peerId: string, connectionId: string, offerer: boolean): void {
    this.closePeer(peerId);

    if (!offerer) {
      return;
    }

    const failure = this.failures.get(peerId);
    const count = failure?.connectionId === connectionId ? failure.count + 1 : 1;
    this.failures.set(peerId, { connectionId, count });

    if (count >= MAX_ATTEMPTS) {
      console.warn(`Gave up connecting to participant ${peerId} for the chat.`);
      return;
    }

    this.clearRetry(peerId);
    this.retryTimers.set(
      peerId,
      window.setTimeout(() => {
        this.retryTimers.delete(peerId);

        if (this.targets.get(peerId) === connectionId && !this.peers.has(peerId)) {
          this.addPeer(peerId, connectionId, true);
        }
      }, RETRY_DELAY_MS),
    );
  }

  private clearRetry(peerId: string): void {
    const timer = this.retryTimers.get(peerId);

    if (timer != null) {
      window.clearTimeout(timer);
      this.retryTimers.delete(peerId);
    }
  }

  private closePeer(peerId: string): void {
    const peer = this.peers.get(peerId);

    if (peer == null) {
      return;
    }

    this.peers.delete(peerId);
    peer.link.close();

    if (peer.open) {
      this.onclose?.(peerId);
    }
  }
}

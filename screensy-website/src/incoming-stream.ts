import type { MessageSignalFromServer } from "screensy-protocol";
import { PeerLink } from "./peer-link.ts";
import type { MessageSender } from "./signaling.ts";

/**
 * A screen that another participant presents to this client.
 */
export class IncomingStream {
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

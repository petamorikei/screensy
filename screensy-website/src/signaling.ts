import type { ClientMessage, MessageJoin, ServerMessage } from "screensy-protocol";
import { ServerMessageSchema } from "screensy-protocol";
import { hidePopup, showPopup } from "./dom.ts";

export type MessageSender = (message: MessageJoin | ClientMessage) => void;

export const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];

/**
 * Connects to the signaling server and reconnects when the connection is lost.
 */
export class SignalingConnection {
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

      // Invalid messages are dropped, like the server does
      const result = ServerMessageSchema.safeParse(message);

      if (result.success) {
        this.onmessage?.(result.data);
      } else {
        console.warn("Dropped an invalid message from the server.", result.error);
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
  send(message: MessageJoin | ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
  }
}

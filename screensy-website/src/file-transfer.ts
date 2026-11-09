import * as z from "zod";
import type { PeerMesh } from "./peer-mesh.ts";

/**
 * The bytes in front of every data message: the transfer ID, as an unsigned 32-bit integer
 */
const HEADER_BYTES = 4;

/**
 * The sender reads the file in blocks of this size, and splits them into messages that fit the channel
 */
const READ_BLOCK_BYTES = 1024 * 1024;

/**
 * The sender waits while more than HIGH is queued on the channel, until it drops to LOW
 */
const BUFFER_HIGH_BYTES = 1024 * 1024;
const BUFFER_LOW_BYTES = 256 * 1024;

/**
 * The receiver folds the received messages into a Blob every so many bytes. The browser may keep a large Blob on disk,
 * but not the messages, so a file of any size does not have to fit in memory.
 */
const FOLD_BYTES = 16 * 1024 * 1024;

/**
 * How often a transfer in progress tells the page, at most
 */
const PROGRESS_INTERVAL_MS = 200;

const MAX_ID_LENGTH = 64;
const TransferIdSchema = z.int().nonnegative().max(0xffffffff);
const IdSchema = z.string().min(1).max(MAX_ID_LENGTH);

/**
 * The control messages of the files channel, as JSON text. The data goes as binary messages.
 */
const FileControlSchema = z.discriminatedUnion("type", [
  /**
   * The chat author ID of the page, so that a receiver finds the sender of a file in the chat
   */
  z.object({ type: z.literal("hello"), authorId: IdSchema }),
  /**
   * The receiver asks for a file that the sender shared
   */
  z.object({ type: z.literal("get"), transferId: TransferIdSchema, fileId: IdSchema }),
  z.object({ type: z.literal("start"), transferId: TransferIdSchema, size: z.int().nonnegative() }),
  z.object({ type: z.literal("end"), transferId: TransferIdSchema }),
  /**
   * The receiver no longer wants it
   */
  z.object({ type: z.literal("cancel"), transferId: TransferIdSchema }),
  /**
   * The sender does not have the file, for example after a reload
   */
  z.object({ type: z.literal("error"), transferId: TransferIdSchema, reason: z.enum(["unavailable"]) }),
]);

type FileControl = z.infer<typeof FileControlSchema>;

/**
 * Where a download of a file stands on this page
 */
export type DownloadState =
  | { status: "idle" }
  | { status: "receiving"; received: number; size: number }
  | { status: "done"; url: string }
  | { status: "failed" };

/**
 * A file as the chat announces it
 */
export interface SharedFileInfo {
  id: string;
  size: number;
  type: string;
}

interface Download {
  readonly peerId: string;
  readonly transferId: number;
  readonly file: SharedFileInfo;
  started: boolean;
  received: number;
  /**
   * The folded parts, and the messages since the last fold
   */
  parts: Blob[];
  pending: ArrayBuffer[];
  pendingBytes: number;
}

const parseControl = (data: string): FileControl | null => {
  try {
    return FileControlSchema.safeParse(JSON.parse(data)).data ?? null;
  } catch {
    return null;
  }
};

/**
 * Waits until the channel has sent most of what is queued, or closes
 */
const drained = (channel: RTCDataChannel): Promise<void> =>
  new Promise((resolve) => {
    const done = () => {
      channel.removeEventListener("bufferedamountlow", done);
      channel.removeEventListener("close", done);
      resolve();
    };

    channel.addEventListener("bufferedamountlow", done);
    channel.addEventListener("close", done);
  });

/**
 * The files of the chat, on the files channel of the mesh: the files that this page shared, which others ask for, and
 * the files that this page asked for. A file goes from its sender only, and only while the sender's page is open.
 */
export class FileTransfers {
  /**
   * A download started, progressed, ended or failed
   */
  public onchange: (() => void) | null = null;

  private readonly mesh: PeerMesh;
  private readonly authorId: string;

  /**
   * The files that this page shared, by file ID. A reload forgets them.
   */
  private readonly shared = new Map<string, File>();

  /**
   * The chat author ID of each peer, from its "hello"
   */
  private readonly authors = new Map<string, string>();

  private readonly downloads = new Map<string, Download>();
  private readonly finished = new Map<string, DownloadState>();
  private nextTransferId = 0;

  /**
   * The transfers that this page sends, as peer ID and transfer ID
   */
  private readonly sending = new Set<string>();
  private progressTimer: number | null = null;

  constructor(mesh: PeerMesh, authorId: string) {
    this.mesh = mesh;
    this.authorId = authorId;
  }

  /**
   * Keeps a file for those who ask for it, and returns its ID for the chat
   */
  share(file: File): string {
    const id = crypto.randomUUID();
    this.shared.set(id, file);
    return id;
  }

  /**
   * Whether a page of that chat author is connected, so that its files can be asked for
   */
  isReachable(authorId: string): boolean {
    return [...this.authors].some(([peerId, author]) => author === authorId && this.mesh.filesChannel(peerId) != null);
  }

  state(fileId: string): DownloadState {
    const download = this.downloads.get(fileId);

    if (download != null) {
      return { status: "receiving", received: download.received, size: download.file.size };
    }

    return this.finished.get(fileId) ?? { status: "idle" };
  }

  /**
   * Asks the sender for a file. A failed or cancelled download can start again.
   */
  download(authorId: string, file: SharedFileInfo): void {
    if (this.downloads.has(file.id) || this.finished.get(file.id)?.status === "done") {
      return;
    }

    const peerId = [...this.authors].find(
      ([peerId, author]) => author === authorId && this.mesh.filesChannel(peerId) != null,
    )?.[0];

    if (peerId == null) {
      this.finished.set(file.id, { status: "failed" });
      this.changed();
      return;
    }

    const transferId = this.nextTransferId++;
    this.finished.delete(file.id);
    this.downloads.set(file.id, {
      peerId,
      transferId,
      file,
      started: false,
      received: 0,
      parts: [],
      pending: [],
      pendingBytes: 0,
    });
    this.sendControl(peerId, { type: "get", transferId, fileId: file.id });
    this.changed();
  }

  /**
   * Stops a download. It can start again.
   */
  cancel(fileId: string): void {
    const download = this.downloads.get(fileId);

    if (download != null) {
      this.sendControl(download.peerId, { type: "cancel", transferId: download.transferId });
      this.downloads.delete(fileId);
      this.changed();
    }
  }

  /**
   * The files channel to a peer opened: tell it who this page is in the chat
   */
  handleOpen(peerId: string): void {
    this.sendControl(peerId, { type: "hello", authorId: this.authorId });
  }

  /**
   * The connection to a peer closed: what it sent is lost, and what it asked for stops
   */
  handleClose(peerId: string): void {
    this.authors.delete(peerId);

    for (const key of [...this.sending]) {
      if (key.startsWith(`${peerId}:`)) {
        this.sending.delete(key);
      }
    }

    for (const [fileId, download] of this.downloads) {
      if (download.peerId === peerId) {
        this.fail(fileId);
      }
    }

    this.changed();
  }

  handleMessage(peerId: string, data: string | ArrayBuffer): void {
    if (data instanceof ArrayBuffer) {
      this.receiveData(peerId, data);
      return;
    }

    const message = parseControl(data);

    if (message == null) {
      console.warn("Dropped an invalid message of the files channel.");
      return;
    }

    switch (message.type) {
      case "hello":
        this.authors.set(peerId, message.authorId);
        this.changed();
        break;
      case "get":
        void this.sendFile(peerId, message.transferId, message.fileId);
        break;
      case "cancel":
        this.sending.delete(`${peerId}:${message.transferId}`);
        break;
      case "start": {
        const download = this.findDownload(peerId, message.transferId);

        if (download != null) {
          if (message.size === download[1].file.size) {
            download[1].started = true;
          } else {
            this.fail(download[0]);
          }
        }

        break;
      }
      case "end":
        this.finish(peerId, message.transferId);
        break;
      case "error": {
        const download = this.findDownload(peerId, message.transferId);

        if (download != null) {
          this.fail(download[0]);
        }

        break;
      }
    }
  }

  /**
   * Forgets the downloaded files
   */
  close(): void {
    for (const state of this.finished.values()) {
      if (state.status === "done") {
        URL.revokeObjectURL(state.url);
      }
    }

    this.finished.clear();
    this.downloads.clear();
    this.sending.clear();
  }

  private findDownload(peerId: string, transferId: number): [string, Download] | null {
    for (const entry of this.downloads) {
      if (entry[1].peerId === peerId && entry[1].transferId === transferId) {
        return entry;
      }
    }

    return null;
  }

  private receiveData(peerId: string, data: ArrayBuffer): void {
    if (data.byteLength < HEADER_BYTES) {
      return;
    }

    const transferId = new DataView(data).getUint32(0);
    const entry = this.findDownload(peerId, transferId);

    if (entry == null) {
      // Cancelled meanwhile
      return;
    }

    const [fileId, download] = entry;
    const payload = data.slice(HEADER_BYTES);

    if (!download.started || download.received + payload.byteLength > download.file.size) {
      this.fail(fileId);
      return;
    }

    download.pending.push(payload);
    download.pendingBytes += payload.byteLength;
    download.received += payload.byteLength;

    if (download.pendingBytes >= FOLD_BYTES) {
      this.fold(download);
    }

    this.progress();
  }

  private fold(download: Download): void {
    download.parts.push(new Blob(download.pending));
    download.pending = [];
    download.pendingBytes = 0;
  }

  private finish(peerId: string, transferId: number): void {
    const entry = this.findDownload(peerId, transferId);

    if (entry == null) {
      return;
    }

    const [fileId, download] = entry;

    if (download.received !== download.file.size) {
      this.fail(fileId);
      return;
    }

    this.fold(download);
    const blob = new Blob(download.parts, { type: download.file.type });
    this.downloads.delete(fileId);
    this.finished.set(fileId, { status: "done", url: URL.createObjectURL(blob) });
    this.changed();
  }

  private fail(fileId: string): void {
    this.downloads.delete(fileId);
    this.finished.set(fileId, { status: "failed" });
    this.changed();
  }

  /**
   * Sends a shared file in messages that fit the channel, without queuing more than BUFFER_HIGH_BYTES
   */
  private async sendFile(peerId: string, transferId: number, fileId: string): Promise<void> {
    const file = this.shared.get(fileId);
    const channel = this.mesh.filesChannel(peerId);

    if (channel == null) {
      return;
    }

    if (file == null) {
      this.sendControl(peerId, { type: "error", transferId, reason: "unavailable" });
      return;
    }

    const key = `${peerId}:${transferId}`;
    const chunkBytes = this.mesh.maxMessageSize(peerId) - HEADER_BYTES;
    this.sending.add(key);
    channel.bufferedAmountLowThreshold = BUFFER_LOW_BYTES;
    this.sendControl(peerId, { type: "start", transferId, size: file.size });

    try {
      for (let blockStart = 0; blockStart < file.size; blockStart += READ_BLOCK_BYTES) {
        const block = await file.slice(blockStart, blockStart + READ_BLOCK_BYTES).arrayBuffer();

        for (let offset = 0; offset < block.byteLength; offset += chunkBytes) {
          if (channel.bufferedAmount > BUFFER_HIGH_BYTES) {
            await drained(channel);
          }

          if (!this.sending.has(key) || channel.readyState !== "open") {
            return;
          }

          const chunk = new Uint8Array(block, offset, Math.min(chunkBytes, block.byteLength - offset));
          const message = new Uint8Array(HEADER_BYTES + chunk.byteLength);
          new DataView(message.buffer).setUint32(0, transferId);
          message.set(chunk, HEADER_BYTES);
          channel.send(message.buffer);
        }
      }

      if (this.sending.has(key)) {
        this.sendControl(peerId, { type: "end", transferId });
      }
    } catch (error) {
      console.warn("Could not send a file.", error);
      this.sendControl(peerId, { type: "error", transferId, reason: "unavailable" });
    } finally {
      this.sending.delete(key);
    }
  }

  private sendControl(peerId: string, message: FileControl): void {
    try {
      this.mesh.filesChannel(peerId)?.send(JSON.stringify(message));
    } catch (error) {
      console.warn("Could not send on the files channel.", error);
    }
  }

  /**
   * Tells the page about the progress, at most every PROGRESS_INTERVAL_MS
   */
  private progress(): void {
    if (this.progressTimer == null) {
      this.progressTimer = window.setTimeout(() => {
        this.progressTimer = null;
        this.onchange?.();
      }, PROGRESS_INTERVAL_MS);
    }
  }

  private changed(): void {
    this.onchange?.();
  }
}

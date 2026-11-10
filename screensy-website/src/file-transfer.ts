import * as z from "zod";
import { SNIFF_BYTES, sniffImageType } from "./image-preview.ts";
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

/**
 * The file IDs per "have" message, so that one fits the smallest channel limit (16 KiB)
 */
const HAVE_CHUNK = 200;

/**
 * The most author IDs that "hello" carries: the current page and its earlier loads
 */
const MAX_AUTHORS = 100;

/**
 * The type of every received file. The type that the sender names is not used: a Blob of "text/html" or
 * "image/svg+xml" that someone opens in a tab would run its scripts with this page's origin. Only the preview of a
 * raster image gets the type that its bytes show.
 */
const RECEIVED_TYPE = "application/octet-stream";

/**
 * The downloads that run at once for the previews, without a click
 */
const PREFETCH_CONCURRENCY = 2;

const MAX_ID_LENGTH = 64;
const TransferIdSchema = z.int().nonnegative().max(0xffffffff);
const IdSchema = z.string().min(1).max(MAX_ID_LENGTH);

/**
 * The control messages of the files channel, as JSON text. The data goes as binary messages.
 */
const FileControlSchema = z.discriminatedUnion("type", [
  /**
   * The chat author IDs of the page, the current one and those of its earlier loads, so that a receiver knows whether
   * the sender of a file is here
   */
  z.object({ type: z.literal("hello"), authorIds: z.array(IdSchema).max(MAX_AUTHORS) }),
  /**
   * Files that the page can pass on: shared by it, or received whole. Sent when the channel opens, then for each new
   * one. A page never stops having a file.
   */
  z.object({ type: z.literal("have"), fileIds: z.array(IdSchema).max(HAVE_CHUNK) }),
  /**
   * The receiver asks for a file
   */
  z.object({ type: z.literal("get"), transferId: TransferIdSchema, fileId: IdSchema }),
  z.object({ type: z.literal("start"), transferId: TransferIdSchema, size: z.int().nonnegative() }),
  z.object({ type: z.literal("end"), transferId: TransferIdSchema }),
  /**
   * The receiver no longer wants it
   */
  z.object({ type: z.literal("cancel"), transferId: TransferIdSchema }),
  /**
   * The page does not have the file
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

/**
 * Whether a character would make a name look like another one, or would not work in a file name: the control
 * characters, and the marks and overrides of bidirectional text, which can turn "exe.pdf" around
 */
const isHiddenCharacter = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0;

  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x61c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
};

/**
 * A file name from someone else, safe to show and to save: without hidden characters and path separators, and
 * without leading or trailing spaces and dots
 */
export const cleanFileName = (name: string): string => {
  const cleaned = [...name]
    .filter((character) => !isHiddenCharacter(character))
    .join("")
    .replace(/[/\\]/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "");

  return cleaned === "" ? "file" : cleaned;
};

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
 * The files of the chat, on the files channel of the mesh. Every page tells the others which files it has: the ones it
 * shared, and the ones it received whole. A receiver asks one of the pages that have the file, so a file stays
 * available while anyone who has it is here, and the sender does not have to send it to everyone.
 */
export class FileTransfers {
  /**
   * A download started, progressed, ended or failed, or the files of the peers changed
   */
  public onchange: (() => void) | null = null;

  private readonly mesh: PeerMesh;
  private readonly ownAuthors: () => string[];

  /**
   * The files that this page can pass on, by file ID: shared or received. A reload forgets them.
   */
  private readonly held = new Map<string, Blob>();

  /**
   * The author IDs and the files of each peer, from its "hello" and "have"
   */
  private readonly authors = new Map<string, Set<string>>();
  private readonly peerFiles = new Map<string, Set<string>>();

  private readonly downloads = new Map<string, Download>();
  private readonly finished = new Map<string, DownloadState>();
  private nextTransferId = 0;

  /**
   * The object URLs of the previews of the held files that are raster images, by file ID
   */
  private readonly previews = new Map<string, string>();

  /**
   * The files to fetch for their previews, newest first, and those already tried, which never start again by
   * themselves: a cancelled or failed one waits for a click
   */
  private readonly prefetchQueue = new Map<string, SharedFileInfo>();
  private readonly prefetchTried = new Set<string>();
  private readonly prefetching = new Set<string>();
  private closed = false;

  /**
   * The transfers that this page sends, as peer ID and transfer ID
   */
  private readonly sending = new Set<string>();
  private progressTimer: number | null = null;

  /**
   * @param ownAuthors The chat author IDs of this page, the current one and those of its earlier loads
   */
  constructor(mesh: PeerMesh, ownAuthors: () => string[]) {
    this.mesh = mesh;
    this.ownAuthors = ownAuthors;
  }

  /**
   * Keeps a file for those who ask for it, and returns its ID for the chat. With an ID, it shares the file of an
   * earlier message again, for example after a reload.
   */
  share(file: File, id: string = crypto.randomUUID()): string {
    this.hold(id, file);
    return id;
  }

  /**
   * Whether this page can pass the file on
   */
  holds(fileId: string): boolean {
    return this.held.has(fileId);
  }

  /**
   * Whether a connected peer has the file
   */
  isAvailable(fileId: string): boolean {
    return this.holders(fileId).length > 0;
  }

  /**
   * Whether a page of that chat author is connected
   */
  isAuthorHere(authorId: string): boolean {
    return [...this.authors].some(([peerId, ids]) => ids.has(authorId) && this.mesh.filesChannel(peerId) != null);
  }

  /**
   * The object URL of the file's preview, if this page holds the file and it is a raster image
   */
  preview(fileId: string): string | null {
    return this.previews.get(fileId) ?? null;
  }

  /**
   * Fetches files for their previews without a click, a few at a time, each once: when a peer that has it is here
   *
   * @param files Newest first
   */
  prefetch(files: SharedFileInfo[]): void {
    for (const file of files) {
      if (!this.prefetchTried.has(file.id) && !this.held.has(file.id)) {
        this.prefetchQueue.set(file.id, file);
      }
    }

    this.pumpPrefetch();
  }

  state(fileId: string): DownloadState {
    const download = this.downloads.get(fileId);

    if (download != null) {
      return { status: "receiving", received: download.received, size: download.file.size };
    }

    return this.finished.get(fileId) ?? { status: "idle" };
  }

  /**
   * Asks one of the peers that have the file for it, chosen at random to spread the load. A failed or cancelled
   * download can start again, maybe from another peer.
   */
  download(file: SharedFileInfo): void {
    if (this.downloads.has(file.id) || this.finished.get(file.id)?.status === "done") {
      return;
    }

    const holders = this.holders(file.id);
    const peerId = holders[Math.floor(Math.random() * holders.length)];

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
      this.prefetchEnded(fileId);
      this.changed();
    }
  }

  /**
   * The files channel to a peer opened: tell it who this page is in the chat, and which files it has
   */
  handleOpen(peerId: string): void {
    this.sendControl(peerId, { type: "hello", authorIds: this.ownAuthors().slice(0, MAX_AUTHORS) });
    this.sendHave(peerId, [...this.held.keys()]);
  }

  /**
   * The connection to a peer closed: what it sent is lost, and what it asked for stops
   */
  handleClose(peerId: string): void {
    this.authors.delete(peerId);
    this.peerFiles.delete(peerId);

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
        this.authors.set(peerId, new Set(message.authorIds));
        this.changed();
        break;
      case "have": {
        const files = this.peerFiles.get(peerId) ?? new Set<string>();

        for (const fileId of message.fileIds) {
          files.add(fileId);
        }

        this.peerFiles.set(peerId, files);
        this.changed();
        // A file to preview may have been waiting for someone who has it
        this.pumpPrefetch();
        break;
      }
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
    this.closed = true;

    for (const state of this.finished.values()) {
      if (state.status === "done") {
        URL.revokeObjectURL(state.url);
      }
    }

    for (const url of this.previews.values()) {
      URL.revokeObjectURL(url);
    }

    this.previews.clear();
    this.prefetchQueue.clear();
    this.prefetching.clear();
    this.finished.clear();
    this.downloads.clear();
    this.sending.clear();
    this.held.clear();
  }

  /**
   * The connected peers that have the file
   */
  private holders(fileId: string): string[] {
    return [...this.peerFiles]
      .filter(([peerId, files]) => files.has(fileId) && this.mesh.filesChannel(peerId) != null)
      .map(([peerId]) => peerId);
  }

  /**
   * Keeps a file to pass on, and tells every peer
   */
  private hold(fileId: string, blob: Blob): void {
    this.held.set(fileId, blob);
    this.prefetchQueue.delete(fileId);
    void this.makePreview(fileId, blob);

    for (const peerId of this.mesh.openPeers()) {
      this.sendHave(peerId, [fileId]);
    }
  }

  /**
   * Makes the preview of a held file whose first bytes show a raster image: a Blob of that type, beside the one of
   * the download, which stays application/octet-stream
   */
  private async makePreview(fileId: string, blob: Blob): Promise<void> {
    if (this.previews.has(fileId)) {
      return;
    }

    let type: string | null;

    try {
      type = sniffImageType(new Uint8Array(await blob.slice(0, SNIFF_BYTES).arrayBuffer()));
    } catch (error) {
      console.warn("Could not read a file for its preview.", error);
      return;
    }

    if (type == null || this.closed || this.previews.has(fileId) || this.held.get(fileId) !== blob) {
      return;
    }

    this.previews.set(fileId, URL.createObjectURL(new Blob([blob], { type })));
    this.changed();
  }

  /**
   * Starts the next downloads for the previews, newest first, up to PREFETCH_CONCURRENCY at once, for the files that a
   * connected peer has
   */
  private pumpPrefetch(): void {
    for (const [fileId, file] of this.prefetchQueue) {
      if (this.prefetching.size >= PREFETCH_CONCURRENCY) {
        return;
      }

      if (this.held.has(fileId) || this.downloads.has(fileId) || this.finished.has(fileId)) {
        // Downloaded or tried by a click meanwhile
        this.prefetchQueue.delete(fileId);
        this.prefetchTried.add(fileId);
        continue;
      }

      if (!this.isAvailable(fileId)) {
        continue;
      }

      this.prefetchQueue.delete(fileId);
      this.prefetchTried.add(fileId);
      this.prefetching.add(fileId);
      this.download(file);
    }
  }

  /**
   * A download ended, so the next one for a preview can start
   */
  private prefetchEnded(fileId: string): void {
    if (this.prefetching.delete(fileId)) {
      this.pumpPrefetch();
    }
  }

  private sendHave(peerId: string, fileIds: string[]): void {
    for (let start = 0; start < fileIds.length; start += HAVE_CHUNK) {
      this.sendControl(peerId, { type: "have", fileIds: fileIds.slice(start, start + HAVE_CHUNK) });
    }
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
    const blob = new Blob(download.parts, { type: RECEIVED_TYPE });
    this.downloads.delete(fileId);
    this.finished.set(fileId, { status: "done", url: URL.createObjectURL(blob) });
    // Pass it on to those who ask
    this.hold(fileId, blob);
    this.changed();
    this.prefetchEnded(fileId);
  }

  private fail(fileId: string): void {
    this.downloads.delete(fileId);
    this.finished.set(fileId, { status: "failed" });
    this.changed();
    this.prefetchEnded(fileId);
  }

  /**
   * Sends a file that this page has, in messages that fit the channel, without queuing more than BUFFER_HIGH_BYTES
   */
  private async sendFile(peerId: string, transferId: number, fileId: string): Promise<void> {
    const file = this.held.get(fileId);
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

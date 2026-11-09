import type { ChatMessage, ChatRanges, ChatWire } from "./chat-protocol.ts";
import { ChatStorageSchema, ChatWireSchema, MAX_CHAT_MESSAGES } from "./chat-protocol.ts";
import { CHAT_STORAGE_PREFIX, getSessionStorage, readStorage, writeStorage } from "./storage.ts";

/**
 * How often the page tells every peer which messages it has, so that a message reaches someone without a direct
 * connection to its author through the others
 */
const SUMMARY_INTERVAL_MS = 20_000;

/**
 * How long a requested message is not asked for again, from this or another peer
 */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * The most messages to ask for at once
 */
const MAX_REQUESTED = MAX_CHAT_MESSAGES;

/**
 * The data channels that the chat sends on: the mesh, as far as the chat needs it
 */
export interface ChatTransport {
  send(peerId: string, data: string): boolean;
  openPeers(): string[];
  maxMessageSize(peerId: string): number;
}

/**
 * An inclusive range of sequence numbers
 */
type Range = [number, number];

const keyOf = (authorId: string, seq: number): string => `${authorId}:${seq}`;

/**
 * The order of the messages on every page: by Lamport time, and among the same time by author and number
 */
const compareMessages = (a: ChatMessage, b: ChatMessage): number => {
  if (a.lamport !== b.lamport) {
    return a.lamport - b.lamport;
  }

  if (a.authorId !== b.authorId) {
    return a.authorId < b.authorId ? -1 : 1;
  }

  return a.seq - b.seq;
};

/**
 * Turns sequence numbers into sorted ranges
 */
const toRanges = (seqs: number[]): Range[] => {
  const ranges: Range[] = [];

  for (const seq of [...seqs].sort((a, b) => a - b)) {
    const last = ranges.at(-1);

    if (last != null && seq <= last[1] + 1) {
      last[1] = Math.max(last[1], seq);
    } else {
      ranges.push([seq, seq]);
    }
  }

  return ranges;
};

/**
 * The parts of the ranges a that are not in the sorted ranges b. It works on the bounds only, because a peer can send
 * a range of any size.
 */
const subtractRanges = (a: Range[], b: Range[]): Range[] => {
  const result: Range[] = [];

  for (const [from, to] of a) {
    let start = from;

    for (const [bFrom, bTo] of b) {
      if (bTo < start) {
        continue;
      }

      if (bFrom > to) {
        break;
      }

      if (bFrom > start) {
        result.push([start, bFrom - 1]);
      }

      start = bTo + 1;

      if (start > to) {
        break;
      }
    }

    if (start <= to) {
      result.push([start, to]);
    }
  }

  return result;
};

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/**
 * The chat of the room, without a server: every page keeps the history and sends its messages to the others on the
 * data channels of the mesh. A page that misses messages, for example because it joined later, reloaded or lost a
 * connection, asks a peer for them.
 *
 * Each page gives itself a new author ID whenever it loads and numbers its messages from 0, so that a gap in the
 * numbers shows a missing message. Pages tell each other which messages they have (a summary) when a channel opens
 * and every SUMMARY_INTERVAL_MS, and ask for what they miss from one peer at a time.
 */
export class Chat {
  /**
   * The messages in order, after every change
   */
  public onchange: ((messages: readonly ChatMessage[]) => void) | null = null;

  /**
   * A new message from someone else, as it was sent
   */
  public onlive: ((message: ChatMessage) => void) | null = null;

  public readonly authorId = crypto.randomUUID();

  private readonly transport: ChatTransport;
  private readonly storageKey: string;
  private roomInstanceId: string | null = null;
  private nextSeq = 0;
  private maxLamport = 0;
  private messages: ChatMessage[] = [];
  private readonly byKey = new Map<string, ChatMessage>();

  /**
   * The Lamport time of the newest message that was dropped to keep MAX_CHAT_MESSAGES. Older ones are not taken
   * again.
   */
  private floor = 0;

  /**
   * The highest dropped number per author. An author's Lamport times grow with the numbers, so every message up to it
   * is older than the floor, and is not asked for.
   */
  private readonly droppedUpTo = new Map<string, number>();

  /**
   * Messages that were asked for, by key, until when (performance.now())
   */
  private readonly requested = new Map<string, number>();

  /**
   * This page's author IDs: the current one and those of earlier loads in the same room instance
   */
  private ownAuthorIds = new Set<string>([this.authorId]);

  private saveQueued = false;
  private readonly summaryTimer: number;

  /**
   * @param roomId The room, whose history the page keeps in sessionStorage
   */
  constructor(roomId: string, transport: ChatTransport) {
    this.transport = transport;
    this.storageKey = CHAT_STORAGE_PREFIX + roomId;
    this.summaryTimer = window.setInterval(() => {
      for (const peerId of this.transport.openPeers()) {
        this.sendSummary(peerId);
      }
    }, SUMMARY_INTERVAL_MS);
  }

  /**
   * Whether the chat knows its room, and can send
   */
  get ready(): boolean {
    return this.roomInstanceId != null;
  }

  /**
   * Sets the room instance from "welcome". The first one restores the history of an earlier load of this page, if
   * it belongs to the same room instance. A different one later means that the room was created again, for example
   * after the server restarted, so the history goes.
   */
  setRoomInstance(roomInstanceId: string): void {
    if (this.roomInstanceId === roomInstanceId) {
      return;
    }

    const first = this.roomInstanceId == null;
    this.roomInstanceId = roomInstanceId;
    this.clear();

    if (first) {
      let stored: unknown = null;

      try {
        stored = JSON.parse(readStorage(getSessionStorage, this.storageKey) ?? "null");
      } catch {
        // Not JSON: no history
      }

      const history = ChatStorageSchema.safeParse(stored);

      if (history.success && history.data.roomInstanceId === roomInstanceId) {
        for (const message of history.data.messages) {
          this.add(message);
        }

        this.ownAuthorIds = new Set([this.authorId, ...history.data.ownAuthorIds]);
      }
    }

    this.changed();
  }

  /**
   * Whether this page sent the message, in this load or an earlier one
   */
  isOwn(message: ChatMessage): boolean {
    return this.ownAuthorIds.has(message.authorId);
  }

  /**
   * Sends a message to every peer. Those without an open channel get it from the next summary.
   */
  send(text: string, participantId: string, name: string): boolean {
    if (this.roomInstanceId == null) {
      return false;
    }

    const message: ChatMessage = {
      authorId: this.authorId,
      seq: this.nextSeq++,
      lamport: this.maxLamport + 1,
      participantId,
      name,
      text,
      sentAt: Date.now(),
    };

    this.add(message);

    for (const peerId of this.transport.openPeers()) {
      this.sendMessages(peerId, [message], true);
    }

    this.changed();
    return true;
  }

  /**
   * A channel opened: tell the peer what this page has
   */
  handlePeerOpen(peerId: string): void {
    this.sendSummary(peerId);
  }

  handleData(peerId: string, data: string): void {
    if (this.roomInstanceId == null) {
      return;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    const result = ChatWireSchema.safeParse(parsed);

    if (!result.success) {
      console.warn("Dropped an invalid chat message from a peer.", result.error);
      return;
    }

    const wire = result.data;

    switch (wire.type) {
      case "summary":
        this.requestMissing(peerId, wire.ranges);
        break;
      case "request":
        this.answer(peerId, wire.floor, wire.want);
        break;
      case "messages":
        this.receive(peerId, wire.messages, wire.live);
        break;
    }
  }

  close(): void {
    window.clearInterval(this.summaryTimer);
  }

  private receive(peerId: string, messages: ChatMessage[], live: boolean): void {
    const added = messages.filter((message) => this.add(message));

    if (added.length === 0) {
      return;
    }

    if (live) {
      // A live message comes from its author, who has every earlier one: ask for those that this page misses
      const earlier: ChatRanges = {};

      for (const message of added) {
        if (message.authorId !== this.authorId) {
          this.onlive?.(message);
        }

        if (message.seq > 0) {
          earlier[message.authorId] = [[0, message.seq - 1]];
        }
      }

      this.requestMissing(peerId, earlier);
    }

    this.changed();
  }

  /**
   * Asks the peer for the messages in its ranges that this page does not have and has not asked anyone for yet
   */
  private requestMissing(peerId: string, theirs: ChatRanges): void {
    const now = performance.now();

    for (const [key, until] of this.requested) {
      if (until <= now) {
        this.requested.delete(key);
      }
    }

    const mine = this.ranges();
    const want: [string, Range[]][] = [];
    let count = 0;

    for (const [authorId, ranges] of Object.entries(theirs)) {
      if (count >= MAX_REQUESTED) {
        break;
      }

      // This page has every message of its own load
      if (authorId === this.authorId) {
        continue;
      }

      const dropped = this.droppedUpTo.get(authorId) ?? -1;
      const wanted = ranges
        .map(([from, to]): Range => [Math.max(from, dropped + 1), to])
        .filter(([from, to]) => from <= to);
      const seqs: number[] = [];

      for (const [from, to] of subtractRanges(wanted, mine.get(authorId) ?? [])) {
        // Skipping the messages already asked for is bounded by the size of this.requested
        for (let seq = from; seq <= to && count < MAX_REQUESTED; seq++) {
          const key = keyOf(authorId, seq);

          if (!this.requested.has(key)) {
            this.requested.set(key, now + REQUEST_TIMEOUT_MS);
            seqs.push(seq);
            count++;
          }
        }
      }

      if (seqs.length > 0) {
        want.push([authorId, toRanges(seqs)]);
      }
    }

    this.sendInChunks(peerId, want, (entries) => ({
      type: "request",
      floor: this.floor,
      want: Object.fromEntries(entries),
    }));
  }

  /**
   * Sends the messages that the peer asked for, except those older than its floor
   */
  private answer(peerId: string, floor: number, want: ChatRanges): void {
    const found = this.messages.filter((message) => {
      const ranges = Object.hasOwn(want, message.authorId) ? want[message.authorId] : undefined;
      return message.lamport > floor && ranges?.some(([from, to]) => from <= message.seq && message.seq <= to);
    });

    this.sendMessages(peerId, found, false);
  }

  private sendSummary(peerId: string): void {
    this.sendInChunks(peerId, [...this.ranges()], (entries) => ({
      type: "summary",
      ranges: Object.fromEntries(entries),
    }));
  }

  private sendMessages(peerId: string, messages: ChatMessage[], live: boolean): void {
    this.sendInChunks(peerId, messages, (chunk) => ({ type: "messages", live, messages: chunk }));
  }

  /**
   * Sends the items in as few messages as the connection takes
   */
  private sendInChunks<T>(peerId: string, items: T[], build: (chunk: T[]) => ChatWire): void {
    const limit = this.transport.maxMessageSize(peerId);
    const emptySize = byteLength(JSON.stringify(build([])));
    let chunk: T[] = [];
    let size = emptySize;

    for (const item of items) {
      // The item and a comma. An entry [key, value] is a little longer than "key":value, so this never falls short.
      const itemSize = byteLength(JSON.stringify(item)) + 1;

      if (chunk.length > 0 && size + itemSize > limit) {
        this.transport.send(peerId, JSON.stringify(build(chunk)));
        chunk = [];
        size = emptySize;
      }

      chunk.push(item);
      size += itemSize;
    }

    if (chunk.length > 0) {
      this.transport.send(peerId, JSON.stringify(build(chunk)));
    }
  }

  /**
   * The numbers of the messages that this page has, by author
   */
  private ranges(): Map<string, Range[]> {
    const seqs = new Map<string, number[]>();

    for (const message of this.messages) {
      const list = seqs.get(message.authorId);

      if (list == null) {
        seqs.set(message.authorId, [message.seq]);
      } else {
        list.push(message.seq);
      }
    }

    return new Map([...seqs].map(([authorId, list]) => [authorId, toRanges(list)]));
  }

  /**
   * Adds a message in order. Returns false for a message that this page has or does not take.
   */
  private add(message: ChatMessage): boolean {
    const key = keyOf(message.authorId, message.seq);
    const dropped = this.droppedUpTo.get(message.authorId);

    if (this.byKey.has(key) || message.lamport <= this.floor || (dropped != null && message.seq <= dropped)) {
      return false;
    }

    this.byKey.set(key, message);
    this.requested.delete(key);
    this.maxLamport = Math.max(this.maxLamport, message.lamport);

    let low = 0;
    let high = this.messages.length;

    while (low < high) {
      const middle = (low + high) >> 1;
      const other = this.messages[middle];

      if (other != null && compareMessages(other, message) < 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    this.messages.splice(low, 0, message);

    while (this.messages.length > MAX_CHAT_MESSAGES) {
      const oldest = this.messages.shift();

      if (oldest == null) {
        break;
      }

      this.byKey.delete(keyOf(oldest.authorId, oldest.seq));
      this.floor = Math.max(this.floor, oldest.lamport);
      this.droppedUpTo.set(oldest.authorId, Math.max(this.droppedUpTo.get(oldest.authorId) ?? -1, oldest.seq));
    }

    return true;
  }

  private clear(): void {
    this.messages = [];
    this.byKey.clear();
    this.requested.clear();
    this.droppedUpTo.clear();
    this.floor = 0;
    this.ownAuthorIds = new Set([this.authorId]);
  }

  /**
   * Reports the messages and saves them once the current task is done
   */
  private changed(): void {
    this.onchange?.(this.messages);

    if (this.saveQueued) {
      return;
    }

    this.saveQueued = true;
    queueMicrotask(() => {
      this.saveQueued = false;

      if (this.roomInstanceId != null) {
        // Too much for the storage is not kept: writeStorage ignores the error
        writeStorage(
          getSessionStorage,
          this.storageKey,
          JSON.stringify({
            roomInstanceId: this.roomInstanceId,
            messages: this.messages,
            // Only those that still have messages
            ownAuthorIds: [...this.ownAuthorIds].filter(
              (authorId) =>
                authorId === this.authorId || this.messages.some((message) => message.authorId === authorId),
            ),
          }),
        );
      }
    });
  }
}

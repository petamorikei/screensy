/**
 * The messages of the chat, which go between the browsers on the data channels of the mesh and never through the
 * server. Every message that arrives is parsed with these schemas, and the invalid ones are dropped.
 */
import * as z from "zod";

/**
 * The longest text of a chat message, in UTF-16 code units like the maxlength of the input
 */
export const MAX_CHAT_TEXT_LENGTH = 4000;

/**
 * The most messages that a page keeps. Older ones are dropped.
 */
export const MAX_CHAT_MESSAGES = 1000;

const MAX_ID_LENGTH = 64;

/**
 * The server allows 32 code points, which are up to 64 code units
 */
const MAX_NAME_LENGTH = 64;

const SeqSchema = z.int().nonnegative();

/**
 * The longest file name and media type that a message announces
 */
const MAX_FILE_NAME_LENGTH = 255;

/**
 * A file that the author shares: the others ask the author's page for it on the files channel
 */
const ChatFileSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH),
  name: z.string().min(1).max(MAX_FILE_NAME_LENGTH),
  size: z.int().nonnegative(),
  type: z.string().max(MAX_FILE_NAME_LENGTH),
});

/**
 * A message is identified by its author, a random ID that the page creates whenever it loads, and the number of the
 * message from that author, counted from 0. Their Lamport time orders the messages the same on every page.
 */
export const ChatMessageSchema = z
  .object({
    authorId: z.string().min(1).max(MAX_ID_LENGTH),
    seq: SeqSchema,
    lamport: z.int().positive(),
    /**
     * The author's participant ID and name when they sent it, for the display
     */
    participantId: z.string().max(MAX_ID_LENGTH),
    name: z.string().max(MAX_NAME_LENGTH),
    /**
     * Empty only beside a file
     */
    text: z.string().max(MAX_CHAT_TEXT_LENGTH),
    /**
     * The time on the author's clock, in milliseconds since the epoch. Only for the display, because clocks differ.
     */
    sentAt: z.number(),
    file: ChatFileSchema.optional(),
  })
  .refine((message) => message.text !== "" || message.file != null);

/**
 * Inclusive ranges of sequence numbers
 */
const RangeSchema = z.tuple([SeqSchema, SeqSchema]).refine(([from, to]) => from <= to);

/**
 * Ranges of sequence numbers by author
 */
const RangesSchema = z
  .record(z.string().min(1).max(MAX_ID_LENGTH), z.array(RangeSchema).max(MAX_CHAT_MESSAGES))
  .refine((ranges) => Object.keys(ranges).length <= MAX_CHAT_MESSAGES);

/**
 * The messages that the sender has, sent when a channel opens and every now and then
 */
const SummarySchema = z.object({
  type: z.literal("summary"),
  ranges: RangesSchema,
});

/**
 * Asks for messages. "floor" is the Lamport time of the newest message that the sender dropped because it had too
 * many: it does not want those back.
 */
const RequestSchema = z.object({
  type: z.literal("request"),
  floor: z.int().nonnegative(),
  want: RangesSchema,
});

/**
 * New messages from their author (live), or older ones in answer to a request
 */
const MessagesSchema = z.object({
  type: z.literal("messages"),
  live: z.boolean(),
  messages: z.array(ChatMessageSchema).max(MAX_CHAT_MESSAGES),
});

export const ChatWireSchema = z.discriminatedUnion("type", [SummarySchema, RequestSchema, MessagesSchema]);

/**
 * What the page keeps in sessionStorage, so that a reload keeps the history
 */
export const ChatStorageSchema = z.object({
  roomInstanceId: z.string(),
  messages: z.array(ChatMessageSchema).max(MAX_CHAT_MESSAGES),
  /**
   * The author IDs of the earlier loads of this page, to show their messages as the own ones
   */
  ownAuthorIds: z.array(z.string().max(MAX_ID_LENGTH)).max(MAX_CHAT_MESSAGES).catch([]),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatFile = z.infer<typeof ChatFileSchema>;
export type ChatRanges = z.infer<typeof RangesSchema>;
export type ChatWire = z.infer<typeof ChatWireSchema>;

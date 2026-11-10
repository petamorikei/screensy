/**
 * The previews of the images in the chat. Only raster images preview: an image opened from a Blob of its own type can
 * be opened in a tab, where SVG would run its scripts with this page's origin. The type comes from the first bytes of
 * the file, never from the type that the sender names.
 */

/**
 * How many bytes the sniffing reads: the WebP signature ends at byte 12
 */
export const SNIFF_BYTES = 12;

/**
 * The receiver fetches an image up to this size without a click, to show its preview
 */
export const AUTO_FETCH_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The types that the sender may name for an image that the receiver fetches without a click. A hint only: the preview
 * still needs the bytes to match.
 */
const PREVIEW_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte);

const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));

/**
 * The image type of a file from its first bytes, or null for anything that is not a PNG, JPEG, GIF or WebP image
 */
export const sniffImageType = (bytes: Uint8Array): string | null => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }

  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) {
    return "image/gif";
  }

  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) {
    return "image/webp";
  }

  return null;
};

/**
 * Whether the receiver fetches a file without a click: an image of a previewable type, small enough
 */
export const fetchesForPreview = (type: string, size: number): boolean =>
  PREVIEW_TYPES.has(type) && size <= AUTO_FETCH_MAX_BYTES;

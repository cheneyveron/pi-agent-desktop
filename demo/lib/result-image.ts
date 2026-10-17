const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/**
 * A file name for a tool-result image. Takes the block's media type, not its src: history
 * serves large tool-result images from an API URL, which carries no type of its own.
 */
export function resultImageFileName(mediaType: string | undefined, index: number): string {
  return `image-${index + 1}.${(mediaType && IMAGE_EXTENSIONS[mediaType.toLowerCase()]) ?? "png"}`;
}

const sourceCache = new WeakMap<object, { payload: string | undefined; type: string | undefined; mediaType: string | undefined; src: string }>();

/**
 * The `src` for an image block: a `data:` URL for inline base64, the block's own URL for
 * deferred ones. Blocks hold base64 that can run to many MB, so the URL is built once per
 * block object and reused: rebuilding it on every render copies the whole payload each time,
 * and block objects keep their identity while the transcript re-renders per streaming delta.
 * The entry is checked against the block's current fields, so a block edited in place is
 * rebuilt. Reads both shapes in circulation: `{ source: { type, data, media_type, url } }`
 * and pi-ai's on-disk `{ data, mimeType }`.
 */
export function imageSource(img: { source?: { type?: string; media_type?: string; data?: string; url?: string } }): string {
  const flat = img as { data?: string; mimeType?: string };
  const payload = img.source ? (img.source.type === "base64" ? img.source.data : img.source.url) : flat.data;
  const type = img.source?.type ?? "flat";
  const mediaType = img.source ? img.source.media_type : flat.mimeType;
  const cached = sourceCache.get(img);
  if (cached && cached.payload === payload && cached.type === type && cached.mediaType === mediaType) return cached.src;
  const src = img.source
    ? img.source.type === "base64"
      ? `data:${mediaType};base64,${payload}`
      : payload ?? ""
    : payload
      ? `data:${mediaType};base64,${payload}`
      : "";
  sourceCache.set(img, { payload, type, mediaType, src });
  return src;
}

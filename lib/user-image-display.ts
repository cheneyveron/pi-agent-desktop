/** Hide only SDK-shaped dimension hints appended to an image-bearing user
 * message. This is a presentation projection: never use it to rewrite stored
 * messages or model input. Without structured SDK metadata, identical manually
 * appended hints cannot be distinguished, so match only the strict suffix and
 * cap distinct hint groups at the attached image count. */
export function userImageDisplayText(text: string, imageCount: number): string {
  if (imageCount <= 0) return text;
  const note = String.raw`\[Image: original [1-9]\d*x[1-9]\d*, displayed at [1-9]\d*x[1-9]\d*\. Multiply coordinates by \d+\.\d{2} to map to original image\.\]`;
  // processImage may emit a conversion hint immediately before its dimension
  // hint. Accept only the SDK's image MIME grammar, not arbitrary bracket text.
  const conversion = String.raw`\[Image converted from image\/[a-z0-9.+-]+ to image\/[a-z0-9.+-]+\.\]`;
  const group = `(?:${conversion}(?:\\n${note})?|${note})`;
  // Hints for multiple images may be separated by one or two newlines. Keep
  // the first separator strict (`\\n\\n`) so an ordinary trailing line is not
  // treated as transport metadata.
  const suffix = text.match(new RegExp(`\\n\\n(${group}(?:(?:\\n|\\n\\n)${group})*)$`));
  if (!suffix || isInsideMarkdownFence(text, suffix.index ?? 0)) return text;
  // Each conversion plus optional dimensions describes one image. Count it as
  // one unit so a converted/resized attachment does not exceed the image cap.
  const units = suffix[1].match(new RegExp(group, "g")) ?? [];
  // Re-editing older messages can append identical metadata repeatedly for a
  // single image. Collapse exact duplicate groups for the safety cap; distinct
  // excess groups remain ambiguous and are deliberately preserved.
  if (new Set(units).size > imageCount) return text;
  // A hint-only image prompt starts with the SDK's two-newline separator.
  // Do not trim normal user whitespace or scan quoted/fenced text in the body.
  return text.slice(0, suffix.index);
}

/** A user can quote an SDK-looking note inside an unfinished fenced block. Keep
 * it visible: an incomplete fence is stronger evidence of user-authored code
 * than the suffix shape is evidence of an SDK transport hint. */
function isInsideMarkdownFence(text: string, offset: number): boolean {
  let fence: { token: string; length: number } | null = null;
  for (const line of text.slice(0, offset).split("\n")) {
    // CommonMark fences allow up to three leading spaces. A closing marker
    // must use the same character, be at least as long, and have no info text.
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!marker) continue;
    const token = marker[1][0];
    if (fence) {
      if (token === fence.token && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (token !== "`" || !marker[2].includes("`")) {
      fence = { token, length: marker[1].length };
    }
  }
  return fence !== null;
}

/** Count attachments structurally; deferred history images also carry type=image.
 * Text-only messages must never have SDK-looking user text silently removed. */
export function userMessageImageCount(content: unknown): number {
  return Array.isArray(content) ? content.filter((block) => block && typeof block === "object" && block.type === "image").length : 0;
}

/** Bound preprocessing work before handing a snapshot to the streaming engine. */
export function streamingMarkdownInterval(text: string): number {
  return Math.min(96, 48 + Math.floor(text.length / 512));
}

/**
 * These constructs depend on document-wide context or on Pi's math/HTML
 * pipeline. Keep them in one syntax tree instead of letting a block lexer
 * separate a reference from its definition or split a display formula.
 * Conservative matches inside code are harmless: they only disable animation.
 */
export function needsWholeMarkdownDocument(text: string): boolean {
  return /^---(?:\r?\n|$)/.test(text)
    || /\[[^\]\n]+\]:/.test(text)
    || /\[\^[^\]\n]*\]/.test(text)
    || /(?:^|\n)[\t >]*(?:\$\$|\\\[)/.test(text)
    || /<\/?[a-z][\w:-]*(?:\s|\/?>|$)/i.test(text);
}

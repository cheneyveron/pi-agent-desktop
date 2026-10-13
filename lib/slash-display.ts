/**
 * Display-only restoration for the exact envelope emitted by pi's
 * `_expandSkillCommand`. The expanded text remains the stored session input.
 */
const SKILL_EXPANSION_RE = /^<skill name="([^"\n]+)" location="([^"\n]+)">\nReferences are relative to [^\n]+\.\n\n([\s\S]*)\n<\/skill>(?:\n\n([\s\S]+))?$/;

export interface SkillExpansion {
  /** Compact command form, e.g. `/skill:review src/main.ts`. */
  command: string;
  /** SKILL.md instructions inside the envelope, without the references line. */
  body: string;
}

/**
 * Parse a complete SDK skill expansion.
 *
 * The expression intentionally requires the opening envelope, matching
 * base-directory reference, final closing tag, and an optional two-newline args
 * suffix. This avoids collapsing ordinary text that merely starts with a
 * skill-looking tag. The greedy body capture makes the final closing tag win
 * when a skill body contains an example `</skill>` tag.
 */
export function parseSkillExpansion(text: string): SkillExpansion | null {
  const match = text.match(SKILL_EXPANSION_RE);
  if (!match) return null;

  const [, name, , body, args] = match;
  return { command: args ? `/skill:${name} ${args}` : `/skill:${name}`, body };
}

/** Restore a complete SDK skill expansion to its compact command form. */
export function skillExpansionToCommand(text: string): string | null {
  return parseSkillExpansion(text)?.command ?? null;
}

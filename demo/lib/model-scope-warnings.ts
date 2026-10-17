/**
 * Structured `enabledModels` scope warnings, shared by the server-side
 * resolver (`lib/model-scope.ts`) and the client-side banner.
 *
 * A `no-match` diagnostic from pi's resolver covers two semantically different
 * situations: the pattern is a genuine typo, or the model exists in the full
 * catalog but its provider has no usable credentials, so `getAvailable()`
 * dropped the model before matching (#48). Rewording the second case into an
 * actionable "provider is not authenticated" warning needs structured data on
 * the wire, so the client can localize and offer a configuration entry point
 * instead of showing the raw English resolver message.
 */

export type ModelScopeWarningCode =
  | "no-match"
  | "invalid-thinking-level"
  /** pi ≥ 1.3: one pattern matched the same model id under several providers. */
  | "ambiguous"
  | "unauthenticated-provider";

export interface ModelScopeWarning {
  code: ModelScopeWarningCode;
  /** The original `enabledModels` pattern the warning is about. */
  pattern: string;
  /**
   * For `unauthenticated-provider`: provider ids the pattern refers to whose
   * models exist in the full catalog but resolve to no usable credentials.
   */
  unauthenticatedProviders?: string[];
  /** Upstream resolver message, kept as the display fallback for other codes. */
  message: string;
}

/** Same list pi's resolver uses to strip `:level` suffixes (case-sensitive). */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Strip a trailing `:thinkingLevel` suffix the same way pi's resolver does. */
export function stripThinkingLevelSuffix(pattern: string): string {
  const colonIdx = pattern.lastIndexOf(":");
  if (colonIdx !== -1 && THINKING_LEVELS.has(pattern.slice(colonIdx + 1))) {
    return pattern.slice(0, colonIdx);
  }
  return pattern;
}

function hasGlobChars(value: string): boolean {
  return value.includes("*") || value.includes("?") || value.includes("[");
}

/**
 * Coarse glob containment: every literal chunk of the pattern must appear in
 * the value. Not full minimatch — classification only needs to answer "could
 * this pattern refer to this provider/model", and a false positive merely
 * keeps the more specific message instead of the raw one.
 */
function chunkMatch(value: string, pattern: string): boolean {
  const chunks = pattern.split(/[*?[\]]+/).filter(Boolean);
  if (chunks.length === 0) return true;
  const lower = value.toLowerCase();
  return chunks.every((chunk) => lower.includes(chunk.toLowerCase()));
}

/** Minimal model shape needed for classification (avoids pulling SDK types). */
export interface CatalogModelRef {
  provider: string;
  id: string;
  name?: string;
}

/**
 * Attribute a `no-match` pattern to unauthenticated providers.
 *
 * Returns the provider ids the pattern can refer to that have no configured
 * auth, or undefined when the candidates are all authenticated (a genuine
 * typo in the model id) or the pattern matches nothing in the full catalog
 * (a genuine typo anywhere). Mirrors the two resolver match paths: a
 * `provider/…` prefix narrows candidates by provider, a bare pattern matches
 * model ids fuzzily across all providers.
 */
export function findUnauthenticatedProvidersForPattern(
  pattern: string,
  catalog: readonly CatalogModelRef[],
  hasConfiguredAuth: (providerId: string) => boolean,
): string[] | undefined {
  const base = stripThinkingLevelSuffix(pattern);
  const slashIdx = base.indexOf("/");
  const candidates = new Set<string>();
  if (slashIdx !== -1) {
    const providerPart = base.slice(0, slashIdx);
    for (const model of catalog) {
      const matches = hasGlobChars(providerPart)
        ? chunkMatch(model.provider, providerPart)
        : model.provider.toLowerCase() === providerPart.toLowerCase();
      if (matches) candidates.add(model.provider);
    }
  } else {
    for (const model of catalog) {
      const matches = hasGlobChars(base)
        // Glob branch of the resolver: minimatch runs against both the full
        // `provider/id` reference and the bare model id.
        ? chunkMatch(`${model.provider}/${model.id}`, base) || chunkMatch(model.id, base)
        : model.id.toLowerCase().includes(base.toLowerCase())
          || (model.name ? model.name.toLowerCase().includes(base.toLowerCase()) : false);
      if (matches) candidates.add(model.provider);
    }
  }
  const unauthenticated = [...candidates].filter((providerId) => !hasConfiguredAuth(providerId));
  return candidates.size > 0 && unauthenticated.length > 0 ? unauthenticated : undefined;
}

/** Stable fingerprint of one warning, used for per-conversation dismissal. */
export function modelScopeWarningKey(warning: ModelScopeWarning): string {
  return [
    warning.code,
    warning.pattern,
    (warning.unauthenticatedProviders ?? []).join(","),
  ].join("\u0000");
}

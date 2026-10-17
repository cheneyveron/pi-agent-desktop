// Tool results carry an opaque `details` payload next to their content. Pi-web
// renders only a handful of its fields, but extensions are free to store
// anything there — browser-automation tools persist a full DOM outline per
// call (measured: 14MB for one `evaluate_browser` result, 97% of a 140MB
// session file). Shipping that verbatim made a 50-entry session load a 54MB
// JSON response, so every path that hands tool results to the browser (and
// the read-only SessionManager cache) projects `details` down to what the UI
// actually reads.
//
// Keep KEPT_DETAIL_KEYS in sync with the UI readers:
// - `patch` / `diff`           MessageView getResultDiff (edit/write diffs)
// - `preview` / `result`       apply_patch rendering + lib/turn-written-files.ts
// - `kind === "pi-web-subagent"` details are kept whole (MessageView subagent card)

const KEPT_DETAIL_KEYS = ["patch", "diff", "preview", "result"] as const;

const SUBAGENT_DETAILS_KIND = "pi-web-subagent";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The subset of a tool result's `details` the UI reads, or `undefined` when
 * none of it is used. Returns the input object itself when nothing would be
 * dropped, so unchanged results keep their identity.
 */
export function projectToolResultDetails(details: unknown): unknown {
  if (details === undefined || details === null) return details;
  if (!isRecord(details)) return undefined;
  if (details.kind === SUBAGENT_DETAILS_KIND) return details;

  let dropped = false;
  for (const key in details) {
    if (!(KEPT_DETAIL_KEYS as readonly string[]).includes(key)) {
      dropped = true;
      break;
    }
  }
  if (!dropped) return details;

  const projected: Record<string, unknown> = {};
  let kept = false;
  for (const key of KEPT_DETAIL_KEYS) {
    if (key in details) {
      projected[key] = details[key];
      kept = true;
    }
  }
  return kept ? projected : undefined;
}

/**
 * Return `message` with projected `details` when it is a tool result whose
 * details carry fields the UI never reads; otherwise return it unchanged.
 */
export function slimToolResultMessage<T>(message: T): T {
  if (!isRecord(message) || message.role !== "toolResult" || !("details" in message)) return message;
  const projected = projectToolResultDetails(message.details);
  if (projected === message.details) return message;
  const { details: _details, ...rest } = message;
  void _details;
  return (projected === undefined ? rest : { ...rest, details: projected }) as T;
}

/** Same projection for a streamed tool execution result (`{ content, details }`). */
export function slimToolExecutionResult<T>(result: T): T {
  if (!isRecord(result) || !("details" in result)) return result;
  const projected = projectToolResultDetails(result.details);
  if (projected === result.details) return result;
  const { details: _details, ...rest } = result;
  void _details;
  return (projected === undefined ? rest : { ...rest, details: projected }) as T;
}

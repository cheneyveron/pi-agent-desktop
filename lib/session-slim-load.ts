// Read-only fast path for opening very large session files.
//
// Browser-automation tools persist a full DOM outline in a tool result's
// `details` (measured: 120 of 129 MB in one session file). The UI never reads
// those fields (lib/tool-result-details.ts), yet `SessionManager.open()` decodes
// and JSON.parses every byte of them: ~650 ms and ~270 MB of transient heap for
// that file. This loader cuts the `details` span out of an oversized tool-result
// line *as bytes*, before decoding, so the dead payload is never turned into a
// string or an object graph.
//
// Only the read-only cached view uses it (`openSessionManager` without
// `mutable`): the manager it builds has persist=false, so a slimmed entry can
// never be written back over the real file.
//
// Every shortcut is verified and falls back to a plain parse of the whole line,
// so a surprising line shape costs speed, never correctness.

import { readFileSync, statSync } from "fs";
import { dirname, resolve } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/** Lines shorter than this are parsed as-is; the strip only pays off on big ones. */
const SLIM_MIN_LINE_BYTES = 256 * 1024;
/** Files below this size keep the SDK's own open path. */
export const SLIM_LOAD_MIN_FILE_BYTES = 16 * 1024 * 1024;
/** Beyond this, a single Buffer is the wrong tool; let the SDK stream it. */
const SLIM_LOAD_MAX_FILE_BYTES = 1024 * 1024 * 1024;
/** `"role":"toolResult"` sits right after the first few short keys. */
const ROLE_PROBE_BYTES = 1024;

const MESSAGE_KEYS = new Set(["role", "toolCallId", "toolName", "content", "details", "isError", "timestamp"]);

const ROLE_TOOL_RESULT = Buffer.from('"role":"toolResult"');
const CONTENT_KEY = Buffer.from('"content":');
const DETAILS_KEY = Buffer.from('"details":');
const IS_ERROR_KEY = Buffer.from(',"isError":');
const TIMESTAMP_KEY = Buffer.from(',"timestamp":');
// Details the UI renders must survive (KEPT_DETAIL_KEYS + subagent cards in
// lib/tool-result-details.ts). Seeing any of them means "use the normal path".
// Tested on a latin1 view of the span: ASCII bytes map 1:1, so this cannot miss
// a marker, and one regex pass is ~6x faster than five Buffer.indexOf scans
// (short, quote-led needles hit `"` on every few bytes of DOM-outline JSON).
const KEPT_DETAIL_MARKERS = /"(?:patch|diff|preview|result)":|"pi-web-subagent"/;

type RawEntry = Record<string, unknown>;

function parseLine(text: string): RawEntry | null {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as RawEntry;
  } catch {
    return null; // malformed lines are skipped, matching the SDK loader
  }
}

/**
 * The line without its `details` value, or null when it is not a plain
 * tool-result message or carries details the UI needs. Works on `buf[start, end)`.
 */
function stripDetails(buf: Buffer, start: number, end: number): string | null {
  const line = buf.subarray(start, end);

  const roleAt = line.indexOf(ROLE_TOOL_RESULT);
  if (roleAt < 0 || roleAt > ROLE_PROBE_BYTES) return null;

  const detailsAt = line.indexOf(DETAILS_KEY);
  if (detailsAt <= 0 || line[detailsAt - 1] !== 0x2c) return null;
  const contentAt = line.indexOf(CONTENT_KEY);
  if (contentAt < 0 || contentAt > detailsAt) return null;

  // `isError` / `timestamp` are the keys pi writes after `details`; the last
  // occurrence of each is the message-level one, the first byte after the value.
  let tailAt = line.lastIndexOf(IS_ERROR_KEY);
  if (tailAt < detailsAt) tailAt = line.lastIndexOf(TIMESTAMP_KEY);
  if (tailAt < detailsAt) return null;

  if (KEPT_DETAIL_MARKERS.test(line.toString("latin1", detailsAt, tailAt))) return null;

  return line.toString("utf8", 0, detailsAt - 1) + line.toString("utf8", tailAt);
}

function isPlainSlimmedToolResult(entry: RawEntry | null): entry is RawEntry {
  if (!entry || entry.type !== "message") return false;
  const message = entry.message as RawEntry | undefined;
  if (!message || message.role !== "toolResult" || "details" in message) return false;
  if (message.content === undefined) return false;
  for (const key of Object.keys(message)) {
    if (!MESSAGE_KEYS.has(key)) return false;
  }
  return true;
}

/** Entries of a session file, with oversized dead tool-result details never parsed. */
export function loadSlimSessionEntries(buf: Buffer): RawEntry[] {
  const entries: RawEntry[] = [];
  let pos = 0;
  while (pos < buf.length) {
    let end = buf.indexOf(0x0a, pos);
    if (end < 0) end = buf.length;

    let entry: RawEntry | null = null;
    if (end - pos >= SLIM_MIN_LINE_BYTES) {
      const stripped = stripDetails(buf, pos, end);
      if (stripped !== null) {
        const candidate = parseLine(stripped);
        if (isPlainSlimmedToolResult(candidate)) entry = candidate;
      }
    }
    if (!entry) entry = parseLine(buf.toString("utf8", pos, end));
    if (entry) entries.push(entry);

    pos = end + 1;
  }
  return entries;
}

type SessionManagerCtor = new (
  cwd: string,
  sessionDir: string,
  sessionFile: string,
  persist: boolean,
  newSessionOptions: undefined,
  preloadedFileEntries: RawEntry[],
) => SessionManager;

/**
 * A read-only SessionManager for `filePath` built from slimmed entries, or
 * undefined when the file is not a good fit (small, huge, no valid header, or
 * the SDK constructor changed shape) — callers then use `SessionManager.open`.
 */
export function openSlimSessionManager(filePath: string): SessionManager | undefined {
  try {
    const resolved = resolve(filePath);
    const { size } = statSync(resolved);
    if (size < SLIM_LOAD_MIN_FILE_BYTES || size > SLIM_LOAD_MAX_FILE_BYTES) return undefined;

    const entries = loadSlimSessionEntries(readFileSync(resolved));
    const header = entries[0];
    if (!header || header.type !== "session" || typeof header.id !== "string") return undefined;

    // persist=false: the manager can never rewrite or append to the real file.
    // The constructor is private in the typings but public at runtime;
    // session-slim-load.test.mjs pins this against SessionManager.open().
    const Ctor = SessionManager as unknown as SessionManagerCtor;
    const cwd = typeof header.cwd === "string" ? header.cwd : process.cwd();
    return new Ctor(cwd, dirname(resolved), resolved, false, undefined, entries);
  } catch {
    return undefined;
  }
}

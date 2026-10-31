// Artifacts across every session, for the Artifacts page: `:::artifact`
// blocks in assistant text, and files the model wrote or edited with the
// `write` / `edit` tools.
//
// The chat's artifact store (lib/artifact-store.ts) only knows the loaded
// window of the open conversation. This index reads session files instead, so
// the page can show artifacts from history pages that were never loaded, from
// branches that are not checked out, and from chats (which have no side panel).
//
// It is derived, never authoritative: each file is re-parsed when its size or
// mtime changes. A file whose bytes never mention `:::artifact` is not parsed,
// and in one that does, only the lines that mention it go through JSON.parse.
// Even so, a cold pass reads every session file (hundreds of MB), so the index
// is also kept in pi-web/artifact-index.json and reloaded after a restart; only
// files whose fingerprint moved since then are read again.

import { createHash } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { userHome } from "./user-home.ts";
import { artifactHasActiveContent, splitArtifacts, type ArtifactType } from "./artifacts.ts";
import type { SessionInfo, SessionWorkspaceKind } from "./types";

const MARKER = ":::artifact";
// How the SDK writes a write/edit call and its result. Only lines holding one
// of these are parsed for files; the bytes check skips files with none.
const FILE_TOOLS = ["write", "edit"] as const;
const FILE_TOOL_MARKERS = FILE_TOOLS.flatMap((tool) => [`"name":"${tool}"`, `"toolName":"${tool}"`]);
const FILE_MARKERS = [MARKER, ...FILE_TOOL_MARKERS].map((marker) => Buffer.from(marker));
/** Larger files are streamed by line instead of read whole. */
const WHOLE_READ_MAX_BYTES = 16 * 1024 * 1024;
const READ_CONCURRENCY = 8;
const MAX_RESULTS = 1000;
const SNIPPET_CONTEXT = 80;
// The SDK writes `type`, `id`, `parentId` first; enough for the branch walk.
const ENTRY_PREFIX_RE = /^\{"type":"([^"\\]+)","id":"([^"\\]+)","parentId":(?:null|"([^"\\]*)")/;
/** Bump when IndexedArtifact or the parser's output changes; older files are ignored. */
const PERSIST_VERSION = 2;
const PERSIST_DELAY_MS = 2_000;

export interface IndexedArtifactVersion {
  entryId: string;
  timestamp: string;
  title: string;
  type: ArtifactType;
  lang: string;
  content: string;
  complete: boolean;
  /** On the branch the session file currently ends on (what the chat shows). */
  onActiveBranch: boolean;
  hash: string;
}

export interface IndexedArtifact {
  identifier: string;
  /** Every occurrence in file order, across all branches. */
  versions: IndexedArtifactVersion[];
}

export type FileTool = (typeof FILE_TOOLS)[number];

/**
 * One successful write/edit call. Only where and when: contents are never
 * kept here (the index is persisted, and files may hold secrets). The page
 * reads the file itself through /api/files.
 */
export interface IndexedFileOp {
  /** As the model wrote it; relative paths resolve against the session cwd. */
  path: string;
  tool: FileTool;
  toolCallId: string;
  entryId: string;
  timestamp: string;
  onActiveBranch: boolean;
}

interface Fingerprint {
  size: number;
  mtimeMs: number;
}

interface FileIndex {
  fp: Fingerprint;
  artifacts: IndexedArtifact[];
  files: IndexedFileOp[];
}

export interface ParsedSession {
  artifacts: IndexedArtifact[];
  files: IndexedFileOp[];
}

interface PersistState {
  /** null turns persistence off (tests). */
  path: string | null;
  loaded: Promise<void> | null;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

declare global {
  var __piWebArtifactIndex: Map<string, FileIndex> | undefined;
  var __piWebArtifactIndexPersist: PersistState | undefined;
}

function cache(): Map<string, FileIndex> {
  if (!globalThis.__piWebArtifactIndex) globalThis.__piWebArtifactIndex = new Map();
  return globalThis.__piWebArtifactIndex;
}

function persistState(): PersistState {
  if (!globalThis.__piWebArtifactIndexPersist) {
    globalThis.__piWebArtifactIndexPersist = { path: join(getAgentDir(), "pi-web", "artifact-index.json"), loaded: null, dirty: false, timer: null };
  }
  return globalThis.__piWebArtifactIndexPersist;
}

/** Seeds the in-memory cache from disk once per process. A bad file is ignored and rewritten. */
function loadPersisted(): Promise<void> {
  const state = persistState();
  if (!state.loaded) {
    const path = state.path;
    state.loaded = path
      ? readFile(path, "utf8").then((text) => {
        const data = JSON.parse(text) as { version?: unknown; files?: unknown };
        if (data.version !== PERSIST_VERSION || !data.files || typeof data.files !== "object") return;
        const map = cache();
        for (const [file, entry] of Object.entries(data.files as Record<string, FileIndex>)) {
          if (!map.has(file) && entry?.fp && Array.isArray(entry.artifacts) && Array.isArray(entry.files)) map.set(file, entry);
        }
      }).catch(() => undefined)
      : Promise.resolve();
  }
  return state.loaded;
}

function writePersisted(): void {
  const state = persistState();
  state.timer = null;
  if (!state.path || !state.dirty) return;
  state.dirty = false;
  try {
    mkdirSync(dirname(state.path), { recursive: true });
    writePrivateFileAtomicSync(state.path, JSON.stringify({ version: PERSIST_VERSION, files: Object.fromEntries(cache()) }));
  } catch {
    // Only a cache: the next change tries again, and a missing file means one cold pass.
  }
}

function schedulePersist(): void {
  const state = persistState();
  state.dirty = true;
  if (!state.path || state.timer) return;
  state.timer = setTimeout(writePersisted, PERSIST_DELAY_MS);
  state.timer.unref?.();
}

function hashVersion(identifier: string, content: string): string {
  return createHash("sha1").update(identifier).update("\0").update(content).digest("hex");
}

type FoundVersion = { identifier: string; version: Omit<IndexedArtifactVersion, "onActiveBranch"> };

function mentionsFileTool(text: string): boolean {
  return FILE_TOOL_MARKERS.some((marker) => text.includes(marker));
}

/** Feeds a session file line by line; `finish()` returns its artifacts and file writes. */
function createArtifactParser() {
  const parents = new Map<string, string | null>();
  let leafId: string | null = null;
  const found: FoundVersion[] = [];
  const calls = new Map<string, Omit<IndexedFileOp, "onActiveBranch">>();
  const succeeded = new Set<string>();

  const line = (text: string) => {
    if (!text.trim()) return;
    if (!text.includes(MARKER) && !mentionsFileTool(text)) {
      const prefix = ENTRY_PREFIX_RE.exec(text);
      if (prefix) {
        if (prefix[1] === "session") return;
        // The SDK's leaf after a load is the last entry in the file.
        parents.set(prefix[2], prefix[3] ?? null);
        leafId = prefix[2];
        return;
      }
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!entry || typeof entry !== "object" || entry.type === "session" || typeof entry.id !== "string") return;
    parents.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : null);
    leafId = entry.id;
    if (entry.type !== "message") return;
    const message = entry.message as { role?: unknown; content?: unknown; toolName?: unknown; toolCallId?: unknown; isError?: unknown } | undefined;
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
    // A call counts once its result says it worked; an interrupted one has none.
    if (message?.role === "toolResult") {
      if (FILE_TOOLS.includes(message.toolName as FileTool) && typeof message.toolCallId === "string" && message.isError !== true) {
        succeeded.add(message.toolCallId);
      }
      return;
    }
    if (message?.role !== "assistant") return;
    if (Array.isArray(message.content) && mentionsFileTool(text)) {
      for (const block of message.content) {
        if (!block || typeof block !== "object" || block.type !== "toolCall" || typeof block.id !== "string") continue;
        if (!FILE_TOOLS.includes(block.name)) continue;
        const path = (block.arguments as { path?: unknown } | undefined)?.path;
        if (typeof path !== "string" || !path.trim()) continue;
        calls.set(block.id, { path, tool: block.name as FileTool, toolCallId: block.id, entryId: entry.id, timestamp });
      }
    }
    if (!text.includes(MARKER)) return;
    const texts = typeof message.content === "string"
      ? [message.content]
      : Array.isArray(message.content)
        ? message.content.flatMap((block) => (
          block && typeof block === "object" && block.type === "text" && typeof block.text === "string" ? [block.text as string] : []
        ))
        : [];
    for (const body of texts) {
      if (!body.includes(MARKER)) continue;
      for (const segment of splitArtifacts(body)) {
        if (segment.kind !== "artifact") continue;
        const { identifier, title, type, lang, content, complete } = segment.block;
        found.push({
          identifier,
          version: { entryId: entry.id, timestamp, title, type, lang, content, complete, hash: hashVersion(identifier, content) },
        });
      }
    }
  };

  const finish = (): ParsedSession => {
    const active = new Set<string>();
    for (let id = leafId; id && !active.has(id); id = parents.get(id) ?? null) active.add(id);
    const byIdentifier = new Map<string, IndexedArtifact>();
    for (const { identifier, version } of found) {
      let artifact = byIdentifier.get(identifier);
      if (!artifact) {
        artifact = { identifier, versions: [] };
        byIdentifier.set(identifier, artifact);
      }
      artifact.versions.push({ ...version, onActiveBranch: active.has(version.entryId) });
    }
    const files = [...calls.values()]
      .filter((call) => succeeded.has(call.toolCallId))
      .map((call) => ({ ...call, onActiveBranch: active.has(call.entryId) }));
    return { artifacts: [...byIdentifier.values()], files };
  };

  return { line, finish };
}

/** Parses one session file's text. Exported for tests. */
export function parseSession(text: string): ParsedSession {
  const parser = createArtifactParser();
  for (const line of text.split("\n")) parser.line(line);
  return parser.finish();
}

/** Parses one session file's text for its artifacts. Exported for tests. */
export function parseSessionArtifacts(text: string): IndexedArtifact[] {
  return parseSession(text).artifacts;
}

async function parseLargeFile(path: string): Promise<ParsedSession> {
  const parser = createArtifactParser();
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) parser.line(line);
  } finally {
    lines.close();
    stream.destroy();
  }
  return parser.finish();
}

async function indexFile(path: string): Promise<FileIndex | null> {
  await loadPersisted();
  let fp: Fingerprint;
  try {
    const stats = await stat(path);
    fp = { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  }
  const cached = cache().get(path);
  if (cached && cached.fp.size === fp.size && cached.fp.mtimeMs === fp.mtimeMs) return cached;
  let parsed: ParsedSession;
  try {
    if (fp.size > WHOLE_READ_MAX_BYTES) {
      parsed = await parseLargeFile(path);
    } else {
      const bytes = await readFile(path);
      parsed = FILE_MARKERS.some((marker) => bytes.includes(marker)) ? parseSession(bytes.toString("utf8")) : { artifacts: [], files: [] };
    }
  } catch {
    return null;
  }
  const next = { fp, ...parsed };
  cache().set(path, next);
  schedulePersist();
  return next;
}

/** Indexes the catalogue's files, reusing every file whose fingerprint held. */
async function indexSessions(sessions: readonly SessionInfo[], signal?: AbortSignal): Promise<Map<string, FileIndex>> {
  const files = new Map<string, FileIndex>();
  const queue = sessions.filter((session) => session.path && !session.transient);
  let next = 0;
  const worker = async () => {
    while (next < queue.length && !signal?.aborted) {
      const session = queue[next++];
      const result = await indexFile(session.path);
      if (result) files.set(session.id, result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, worker));
  // Forget deleted files so the cache does not grow with every session ever opened.
  // Only after a complete pass: an aborted one has not seen every live file.
  if (!signal?.aborted) {
    const live = new Set(queue.map((session) => session.path));
    let removed = false;
    for (const path of cache().keys()) {
      if (!live.has(path)) {
        cache().delete(path);
        removed = true;
      }
    }
    if (removed) schedulePersist();
  }
  return files;
}

export interface ArtifactSnippet {
  before: string;
  match: string;
  after: string;
}

/** The conversation an output came from (for a file, the latest write or edit). */
interface OutputSource {
  sessionId: string;
  sessionTitle: string;
  cwd: string;
  projectRoot?: string;
  projectKey?: string;
  workspaceKind?: SessionWorkspaceKind;
  /** Output of a scheduled task's run. */
  scheduled: boolean;
}

export interface ArtifactSummary extends OutputSource {
  kind: "artifact";
  identifier: string;
  title: string;
  type: ArtifactType;
  versionCount: number;
  updated: string;
  /** Scripts or handlers: the page shows source until the user asks to run it. */
  activeContent: boolean;
  /** Content matched the query (title matches carry no snippet). */
  snippet?: ArtifactSnippet;
}

/** A file the model wrote or edited, merged across every conversation that touched it. */
export interface FileOutputSummary extends OutputSource {
  kind: "file";
  /** Absolute. */
  path: string;
  /** Relative to the project, else `~/…` under the home folder, else absolute. */
  displayPath: string;
  title: string;
  /** Some call wrote the whole file; otherwise it was only edited. */
  created: boolean;
  /** Successful write/edit calls. */
  versionCount: number;
  updated: string;
  /** Gone from disk (deleted or moved since). */
  missing: boolean;
}

export type OutputSummary = ArtifactSummary | FileOutputSummary;

export interface ArtifactListResponse {
  artifacts: OutputSummary[];
  /** More matched than were returned. */
  truncated: boolean;
}

/** A row's subtitle; the first message can be a whole pasted document. */
const SESSION_TITLE_MAX = 120;

function sessionTitle(session: SessionInfo): string {
  const title = (session.name || session.firstMessage || session.id).replace(/\s+/g, " ").trim();
  return title.length > SESSION_TITLE_MAX ? `${title.slice(0, SESSION_TITLE_MAX - 1)}…` : title;
}

function outputSource(session: SessionInfo): OutputSource {
  return {
    sessionId: session.id,
    sessionTitle: sessionTitle(session),
    cwd: session.cwd,
    projectRoot: session.projectRoot,
    projectKey: session.projectKey,
    workspaceKind: session.workspaceKind,
    scheduled: session.relation?.kind === "scheduled",
  };
}

/** Where a call's path points: `~` is the home folder, relative paths start at the session cwd. */
export function resolveFileOpPath(path: string, cwd: string): string {
  if (path === "~") return userHome();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(userHome(), path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

interface FileOutputOp extends IndexedFileOp {
  session: SessionInfo;
}

/**
 * Every file's successful calls, by absolute path. A fork repeats its
 * source's calls under the same tool-call ids; each call counts once.
 */
function collectFileOps(sessions: readonly SessionInfo[], files: Map<string, FileIndex>): Map<string, FileOutputOp[]> {
  const byPath = new Map<string, FileOutputOp[]>();
  const seen = new Set<string>();
  for (const session of sessions) {
    for (const op of files.get(session.id)?.files ?? []) {
      if (seen.has(op.toolCallId)) continue;
      seen.add(op.toolCallId);
      const path = resolveFileOpPath(op.path, session.cwd);
      let ops = byPath.get(path);
      if (!ops) {
        ops = [];
        byPath.set(path, ops);
      }
      ops.push({ ...op, session });
    }
  }
  for (const ops of byPath.values()) ops.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return byPath;
}

function within(parent: string, path: string): string | null {
  const rest = relative(parent, path);
  return rest && !rest.startsWith("..") && !isAbsolute(rest) ? rest : null;
}

export function displayFilePath(path: string, root: string): string {
  const inRoot = within(root, path);
  if (inRoot) return inRoot;
  const inHome = within(userHome(), path);
  return inHome ? `~${sep}${inHome}` : path;
}

async function isMissing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch {
    return true;
  }
}

/**
 * A fork starts as a copy of its source. Its artifacts are listed only when
 * they hold a version the source does not, so one page is not shown twice.
 */
function inheritedKeys(session: SessionInfo, files: Map<string, FileIndex>): Set<string> | null {
  if (session.relation?.kind !== "fork" || !session.parentSessionId) return null;
  const source = files.get(session.parentSessionId);
  if (!source) return null;
  return new Set(source.artifacts.flatMap((artifact) => artifact.versions.map((version) => version.hash)));
}

function snippetOf(text: string, start: number, length: number): ArtifactSnippet {
  const end = start + length;
  return {
    before: (start > SNIPPET_CONTEXT ? "…" : "") + text.slice(Math.max(0, start - SNIPPET_CONTEXT), start).replace(/\s+/g, " ").trimStart(),
    match: text.slice(start, end).replace(/\s+/g, " "),
    after: text.slice(end, end + SNIPPET_CONTEXT).replace(/\s+/g, " ").trimEnd() + (end + SNIPPET_CONTEXT < text.length ? "…" : ""),
  };
}

/**
 * Literal, case-insensitive match against the identifier, any version's title,
 * then the content (newest version first). Null when nothing matched.
 */
function matchArtifact(artifact: IndexedArtifact, needle: string): { snippet?: ArtifactSnippet } | null {
  if (!needle) return {};
  if (artifact.identifier.toLowerCase().includes(needle)) return {};
  if (artifact.versions.some((version) => version.title.toLowerCase().includes(needle))) return {};
  for (let index = artifact.versions.length - 1; index >= 0; index--) {
    const content = artifact.versions[index].content;
    const at = content.toLowerCase().indexOf(needle);
    if (at >= 0) return { snippet: snippetOf(content, at, needle.length) };
  }
  return null;
}

/**
 * Summarises the newest artifacts matching `query` (all of them when empty).
 * Type and project filters run in the page over this list. Subagent sessions
 * are left out: their prompts are exact and never ask for artifacts.
 */
export async function listArtifacts(
  sessions: readonly SessionInfo[],
  query = "",
  signal?: AbortSignal,
): Promise<ArtifactListResponse> {
  const candidates = sessions.filter((session) => session.relation?.kind !== "subagent");
  const files = await indexSessions(candidates, signal);
  const needle = query.trim().toLowerCase();
  const all: OutputSummary[] = [];
  for (const session of candidates) {
    const file = files.get(session.id);
    if (!file?.artifacts.length) continue;
    const inherited = inheritedKeys(session, files);
    for (const artifact of file.artifacts) {
      if (inherited && artifact.versions.every((version) => inherited.has(version.hash))) continue;
      const latest = artifact.versions.at(-1)!;
      const matched = matchArtifact(artifact, needle);
      if (!matched) continue;
      all.push({
        ...outputSource(session),
        kind: "artifact",
        identifier: artifact.identifier,
        title: latest.title,
        type: latest.type,
        versionCount: artifact.versions.length,
        updated: latest.timestamp || session.modified,
        activeContent: artifactHasActiveContent(latest),
        ...matched,
      });
    }
  }
  // Files match on their path; their contents are not indexed.
  for (const [path, ops] of collectFileOps(candidates, files)) {
    if (needle && !path.toLowerCase().includes(needle)) continue;
    const latest = ops.at(-1)!;
    all.push({
      ...outputSource(latest.session),
      kind: "file",
      path,
      displayPath: displayFilePath(path, latest.session.projectRoot ?? latest.session.cwd),
      title: basename(path),
      created: ops.some((op) => op.tool === "write"),
      versionCount: ops.length,
      updated: latest.timestamp || latest.session.modified,
      missing: false,
    });
  }
  all.sort((a, b) => b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title));
  const shown = all.slice(0, MAX_RESULTS);
  await Promise.all(shown.map(async (item) => {
    if (item.kind === "file") item.missing = await isMissing(item.path);
  }));
  return { artifacts: shown, truncated: all.length > MAX_RESULTS };
}

export interface FileOutputOpInfo {
  sessionId: string;
  sessionTitle: string;
  tool: FileTool;
  toolCallId: string;
  entryId: string;
  timestamp: string;
  onActiveBranch: boolean;
}

export interface FileOutputDetail {
  path: string;
  missing: boolean;
  /** Oldest first. */
  ops: FileOutputOpInfo[];
}

/** Every recorded write/edit of one file, or null when no conversation touched it. */
export async function getFileOutput(sessions: readonly SessionInfo[], path: string): Promise<FileOutputDetail | null> {
  const candidates = sessions.filter((session) => session.relation?.kind !== "subagent");
  const ops = collectFileOps(candidates, await indexSessions(candidates)).get(path);
  if (!ops) return null;
  return {
    path,
    missing: await isMissing(path),
    ops: ops.map((op) => ({
      sessionId: op.session.id,
      sessionTitle: sessionTitle(op.session),
      tool: op.tool,
      toolCallId: op.toolCallId,
      entryId: op.entryId,
      timestamp: op.timestamp,
      onActiveBranch: op.onActiveBranch,
    })),
  };
}

/**
 * What one `write` call put in the file, read back from the transcript (the
 * index keeps no contents). Lets the page show a file that is gone from disk.
 */
export async function getWrittenContent(session: SessionInfo, toolCallId: string): Promise<{ path: string; content: string } | null> {
  if (!session.path || session.transient) return null;
  const needle = `"id":${JSON.stringify(toolCallId)}`;
  const stream = createReadStream(session.path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes(needle) || !line.includes('"name":"write"')) continue;
      let entry: { message?: { role?: unknown; content?: unknown } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
      for (const block of entry.message.content) {
        if (block?.type !== "toolCall" || block.id !== toolCallId || block.name !== "write") continue;
        const { path, content } = (block.arguments ?? {}) as { path?: unknown; content?: unknown };
        if (typeof path === "string" && typeof content === "string") return { path, content };
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return null;
}

/** One artifact with every version's content, or null when it is gone. */
export async function getArtifact(session: SessionInfo, identifier: string): Promise<IndexedArtifact | null> {
  if (!session.path || session.transient) return null;
  const file = await indexFile(session.path);
  return file?.artifacts.find((artifact) => artifact.identifier === identifier) ?? null;
}

/** Test hook. Persistence stays off unless a test passes a path. */
export function resetArtifactIndexForTests(persistPath: string | null = null): void {
  const timer = globalThis.__piWebArtifactIndexPersist?.timer;
  if (timer) clearTimeout(timer);
  globalThis.__piWebArtifactIndex = undefined;
  globalThis.__piWebArtifactIndexPersist = { path: persistPath, loaded: null, dirty: false, timer: null };
}

/** Test hook: writes a pending index file now. */
export function flushArtifactIndexForTests(): void {
  const timer = globalThis.__piWebArtifactIndexPersist?.timer;
  if (timer) clearTimeout(timer);
  writePersisted();
}

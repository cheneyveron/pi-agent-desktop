// Which files the Artifacts page shows as outputs (what the user asked for or
// was pointed at) and which are process files (code, config, scripts and
// intermediate data the agent touched on the way). Pure rules; the index
// gathers the facts they read. docs/agents/artifacts.md has the reasoning.

import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, sep } from "node:path";

export type FileOutputRole = "output" | "process";

/** Why a file is an output, strongest first. */
export type FileOutputReason = "pinned" | "requested" | "mentioned" | "created";

/** Files a person opens to read or use, as opposed to source and config. */
const DELIVERABLE_EXTENSIONS = [
  "html", "htm", "md", "markdown", "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "csv", "pages", "numbers",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "mov", "webm", "mp3", "wav", "m4a",
] as const;

const DELIVERABLE_EXT_SET = new Set<string>(DELIVERABLE_EXTENSIONS);

/** Byte patterns a session file must contain before it is parsed for mentions. */
export const DELIVERABLE_EXTENSION_MARKERS: readonly string[] = DELIVERABLE_EXTENSIONS.map((ext) => `.${ext}`);

function extensionOf(path: string): string {
  return basename(path).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
}

export function isDeliverablePath(path: string): boolean {
  return DELIVERABLE_EXT_SET.has(extensionOf(path));
}

const SECRET_NAME_RE = /^(?:auth|credentials?|secrets?|tokens?)\.json$|^\.env(?:\..+)?$|\.(?:pem|p12|pfx)$|^id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?$|^\.netrc$|^\.npmrc$/i;
const HIDDEN_SEGMENTS = new Set(["node_modules", ".git"]);

/**
 * Never listed, not even as a process file: credentials (a real history holds
 * an `edit` of auth.json with an API key; its preview would show it) and
 * dependency or git internals nobody opens from here.
 */
export function isHiddenOutputPath(path: string): boolean {
  if (SECRET_NAME_RE.test(basename(path))) return true;
  return path.split(/[\\/]/).some((segment) => HIDDEN_SEGMENTS.has(segment));
}

function within(parent: string, path: string): string | null {
  const rest = relative(parent, path);
  return rest && !rest.startsWith("..") && !isAbsolute(rest) ? rest : null;
}

/**
 * Some folder on the way to the file starts with a dot (`~/.pi/agent/…`,
 * `.github/…`): tool and app configuration. Measured from the conversation's
 * folder when the file is inside it, else from home, so a project that itself
 * sits under a dot folder (a worktree in `.claude/worktrees/`) still counts.
 */
export function isInDotFolder(path: string, cwd: string, home: string): boolean {
  const rest = within(cwd, path) ?? within(home, path) ?? path;
  return rest.split(sep).slice(0, -1).some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..");
}

const TEMP_ROOTS = [...new Set([tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"])];

/**
 * Scratch space and app data: temp folders, where pieces of a page are
 * assembled, and `~/Library`, where apps keep their own documents. A new file
 * there is not an output by itself; a reply handing it over still makes it one.
 */
export function isInAppOrTempFolder(path: string, home: string): boolean {
  if (TEMP_ROOTS.some((root) => within(root, path))) return true;
  return within(home, path)?.split(sep)[0] === "Library";
}

/** Instructions and memory for agents, not documents for the user. */
const AGENT_FILE_RE = /^(?:AGENTS|CLAUDE|GEMINI|SKILL|MEMORY|SOUL|USER|IDENTITY|TOOLS|HEARTBEAT)\.md$/i;
const MARKDOWN_RE = /\.(?:md|markdown)$/i;

export interface FileOutputFacts {
  path: string;
  /** Some recorded `write` created or replaced the whole file, or it was born during a conversation that pointed at it. */
  created: boolean;
  /** The user named the file in one of their messages. */
  userMentioned: boolean;
  /** A reply named the file. */
  assistantMentioned: boolean;
  /** Inside a git work tree: its files are the project's, reviewed through git. */
  inRepo: boolean;
  inDotFolder: boolean;
  inAppOrTempFolder: boolean;
  /** The user's own choice from the page. */
  override?: FileOutputRole;
}

export interface FileOutputClass {
  role: FileOutputRole;
  /** Strongest first; empty for process files. */
  reasons: FileOutputReason[];
}

/**
 * Outputs are deliverable files the conversation pointed at: the user named
 * them, a reply named them, or they are new documents outside any repository.
 * Only the user naming a file makes these outputs: agent instructions and
 * memory (`AGENTS.md`, `SKILL.md`, Markdown under a dot folder such as
 * `~/.pi/agent/`) and existing repository files that were only edited. A new
 * file counts by itself only outside repositories, temp and app folders, and
 * when its name does not start with `_` (pieces a page is assembled from).
 */
export function classifyFileOutput(facts: FileOutputFacts): FileOutputClass {
  if (facts.override === "output") return { role: "output", reasons: ["pinned"] };
  if (facts.override === "process") return { role: "process", reasons: [] };
  if (!isDeliverablePath(facts.path)) return { role: "process", reasons: [] };
  const reasons: FileOutputReason[] = [];
  if (facts.userMentioned) reasons.push("requested");
  const name = basename(facts.path);
  const agentFile = AGENT_FILE_RE.test(name) || (facts.inDotFolder && MARKDOWN_RE.test(name));
  const projectWork = agentFile || (facts.inRepo && !facts.created);
  if (!projectWork) {
    if (facts.assistantMentioned) reasons.push("mentioned");
    if (facts.created && !facts.inRepo && !facts.inAppOrTempFolder && !name.startsWith("_")) reasons.push("created");
  }
  return reasons.length ? { role: "output", reasons } : { role: "process", reasons: [] };
}

// Path-like runs in prose. File names are often CJK, so anything that is not
// whitespace, quoting or punctuation counts; a run that swallowed the words
// before it resolves to nothing on disk and is dropped there.
const PATH_RUN_RE = /(?:file:\/\/)?[^\s`'"<>()[\]{}|*?,;，。、；：（）【】「」『』《》！？“”‘’]+\.([A-Za-z0-9]+)(?=$|[\s`'"<>()[\]{}|*?,;:，。、；：（）【】「」『』《》！？“”‘’.])/g;
const CODE_SPAN_RE = /`([^`\n]+)`/g;
const LINK_TARGET_RE = /\]\(([^)\s]+)\)/g;
const MAX_MENTION_LENGTH = 1024;

function cleanMention(raw: string): string | null {
  let value = raw.trim().replace(/^file:\/\//, "").replace(/:\d+(?::\d+)?$/, "").replace(/^[*_]+|[*_]+$/g, "");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  try {
    if (value.includes("%")) value = decodeURIComponent(value);
  } catch {
    // Keep the raw text.
  }
  if (!value || value.length > MAX_MENTION_LENGTH || !isDeliverablePath(value)) return null;
  return value;
}

/** Deliverable file paths named in a message's text: code spans, link targets and bare paths. */
export function extractFileMentions(text: string): string[] {
  const found = new Set<string>();
  const add = (raw: string) => {
    const value = cleanMention(raw);
    if (value) found.add(value);
  };
  for (const match of text.matchAll(CODE_SPAN_RE)) add(match[1]);
  for (const match of text.matchAll(LINK_TARGET_RE)) add(match[1]);
  for (const match of text.matchAll(PATH_RUN_RE)) add(match[0]);
  return [...found];
}

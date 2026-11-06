// What a read-only dispatched session may run in bash. One simple command per call, no shell
// operators, and only these prefixes: git log/show/status/diff/ls-remote, gh pr view/checks/list,
// `curl -s` GET requests, and wisp SELECT queries. Everything else is refused.

export const READONLY_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

export type GuardVerdict = { ok: true } | { ok: false; reason: string };

/** Characters the shell would act on: anywhere outside quotes, and the expanding ones inside "…". */
function hasShellSyntax(command: string): boolean {
  let quote: string | null = null;
  for (const ch of command) {
    if (ch === "\n" || ch === "\r") return true;
    if (quote === "'") { if (ch === "'") quote = null; continue; }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "`" || ch === "$" || ch === "\\") return true;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/[;&|<>`$\\()]/.test(ch)) return true;
  }
  return false;
}
const GIT_SUBCOMMANDS = new Set(["log", "show", "status", "diff", "ls-remote"]);
const GH_PR_SUBCOMMANDS = new Set(["view", "checks", "list"]);
const CURL_WRITE_FLAGS = /^(-d|--data.*|-F|--form.*|-T|--upload-file|-o|--output|-O|--remote-name.*|-K|--config|-u|--user|--json|-X|--request)$/;
const SQL_WRITE = /\b(insert|update|delete|drop|alter|create|truncate|exec|execute|merge|grant|revoke|into)\b/i;

/** Split a command line into words, honouring single and double quotes. */
export function splitWords(command: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  let has = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) {
      if (has || current) { words.push(current); current = ""; has = false; }
      continue;
    }
    current += ch;
    has = true;
  }
  if (quote) return null;
  if (has || current) words.push(current);
  return words;
}

function checkCurl(words: string[]): GuardVerdict {
  if (words[1] !== "-s" && words[1] !== "-sS" && words[1] !== "--silent") return { ok: false, reason: "curl must start with `curl -s`" };
  for (let i = 2; i < words.length; i++) {
    const w = words[i];
    if (w === "-X" || w === "--request") {
      if ((words[i + 1] ?? "").toUpperCase() !== "GET") return { ok: false, reason: "curl may only send GET" };
      i++;
      continue;
    }
    if (/^-X[A-Za-z]+$/.test(w) && w.slice(2).toUpperCase() !== "GET") return { ok: false, reason: "curl may only send GET" };
    if (CURL_WRITE_FLAGS.test(w)) return { ok: false, reason: `curl option ${w} is not allowed` };
  }
  return { ok: true };
}

export function checkReadonlyBash(command: string): GuardVerdict {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, reason: "empty command" };
  if (hasShellSyntax(trimmed)) return { ok: false, reason: "shell operators, substitutions and redirections are not allowed" };
  const words = splitWords(trimmed);
  if (!words || words.length === 0) return { ok: false, reason: "unbalanced quotes" };
  const [cmd] = words;
  if (cmd === "git") {
    let i = 1;
    if (words[i] === "-C") i += 2;
    if (words[i] === "--no-pager") i++;
    if (!GIT_SUBCOMMANDS.has(words[i] ?? "")) return { ok: false, reason: `git ${words[i] ?? ""} is not read-only` };
    const writer = words.slice(i + 1).find((w) => /^--(output|ext-diff|textconv)(=|$)/.test(w));
    return writer ? { ok: false, reason: `git option ${writer} is not allowed` } : { ok: true };
  }
  if (cmd === "gh") {
    return words[1] === "pr" && GH_PR_SUBCOMMANDS.has(words[2] ?? "")
      ? { ok: true }
      : { ok: false, reason: `gh ${words.slice(1, 3).join(" ")} is not allowed` };
  }
  if (cmd === "curl") return checkCurl(words);
  if (cmd === "wisp") {
    const sql = words.slice(1).join(" ");
    if (!/\bselect\b/i.test(sql)) return { ok: false, reason: "wisp may only run SELECT" };
    if (SQL_WRITE.test(sql)) return { ok: false, reason: "wisp query contains a write keyword" };
    return { ok: true };
  }
  return { ok: false, reason: `${cmd} is not on the read-only list` };
}

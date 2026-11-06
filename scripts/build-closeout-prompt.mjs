#!/usr/bin/env node
// Writes lib/closeout-prompt.generated.ts from lib/closeout-prompt.md. The
// server bundle cannot read a markdown file next to a module at run time
// (standalone desktop builds copy only traced code), so the prompt ships as a
// string; lib/closeout-extension.test.mjs fails when the two drift.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function renderCloseoutPromptModule(markdown) {
  return `// Generated from lib/closeout-prompt.md by scripts/build-closeout-prompt.mjs. Edit the .md, then rerun.\nexport const CLOSEOUT_PROMPT = ${JSON.stringify(markdown)};\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const markdown = readFileSync(join(root, "lib/closeout-prompt.md"), "utf8");
  writeFileSync(join(root, "lib/closeout-prompt.generated.ts"), renderCloseoutPromptModule(markdown));
}

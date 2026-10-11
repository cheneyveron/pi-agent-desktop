#!/usr/bin/env node
// Rewrites the version and sha256 of Casks/pi-agent.rb for a published release.
//   node scripts/update-homebrew-cask.mjs <version> <sha256>
// The release workflow calls this after the release is published, with the
// digest GitHub reports for the aarch64 DMG.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const CASK_PATH = fileURLToPath(new URL("../Casks/pi-agent.rb", import.meta.url));

export function updateCask(source, version, sha256) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid version: ${version}`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Invalid sha256: ${sha256}`);
  const next = source
    .replace(/^(\s*version )"[^"]*"/m, `$1"${version}"`)
    .replace(/^(\s*sha256 )"[^"]*"/m, `$1"${sha256}"`);
  if (!next.includes(`version "${version}"`) || !next.includes(`sha256 "${sha256}"`)) {
    throw new Error("Casks/pi-agent.rb has no version/sha256 line to update");
  }
  return next;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, rawSha] = process.argv.slice(2);
  if (!version || !rawSha) {
    console.error("usage: update-homebrew-cask.mjs <version> <sha256>");
    process.exit(2);
  }
  const sha256 = rawSha.replace(/^sha256:/, "");
  await writeFile(CASK_PATH, updateCask(await readFile(CASK_PATH, "utf8"), version, sha256));
  console.log(`Casks/pi-agent.rb -> ${version} (${sha256})`);
}

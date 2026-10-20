import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * tauri-action writes `api.github.com/repos/.../releases/assets/<id>` into
 * latest.json. The updater downloads those anonymously, and the REST API
 * allows only 60 requests an hour per IP, so a few update checks later the
 * download fails with "403 Forbidden" (v0.7.8). The public download URL is
 * served from the CDN without that limit.
 */
export function publicUpdaterManifest(manifest, assets, repository, tag) {
  const names = new Map(assets.map((asset) => [asset.apiUrl, asset.name]));
  const platforms = {};
  for (const [target, entry] of Object.entries(manifest.platforms ?? {})) {
    const name = names.get(entry.url);
    if (!name) {
      if (entry.url.startsWith(`https://github.com/${repository}/releases/download/${tag}/`)) {
        platforms[target] = entry;
        continue;
      }
      throw new Error(`${target}: ${entry.url} matches no asset of ${tag}`);
    }
    platforms[target] = {
      ...entry,
      url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(name)}`,
    };
  }
  return { ...manifest, platforms };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [manifestPath, assetsPath, repository, tag] = process.argv.slice(2);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const { assets } = JSON.parse(await readFile(assetsPath, "utf8"));
  const rewritten = publicUpdaterManifest(manifest, assets, repository, tag);
  await writeFile(manifestPath, `${JSON.stringify(rewritten, null, 2)}\n`);
  for (const [target, entry] of Object.entries(rewritten.platforms)) console.log(`${target} -> ${entry.url}`);
}

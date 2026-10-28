import { fileURLToPath } from "node:url";

/**
 * tauri-action looks the draft up by tag name and only uploads assets into it:
 * it never moves the draft's target commit or replaces its notes. v0.7.14's
 * first run (at ddd1b2fb) failed and left a draft; the run that later succeeded
 * at 4256a3f2 filled that draft, so the Release went out with installers from
 * one commit, the tag on another and the old commit's notes.
 *
 * `prepare` runs before any platform builds: a draft of this tag aimed at
 * another commit is deleted, so tauri-action creates a fresh one with this
 * run's target and notes. A rerun of failed jobs keeps the same commit, so its
 * draft and the assets already uploaded stay. `check` runs right before
 * publishing and refuses a draft or tag that does not point at this commit.
 */
export function planReleaseDraft({ mode, releases, tag, tagSha, sha }) {
  const sameTag = releases.filter((release) => release.tag_name === tag);
  const published = sameTag.find((release) => !release.draft);
  if (published) throw new Error(`${tag} is already published; bump the version before releasing again`);
  if (tagSha && tagSha !== sha) {
    throw new Error(`Tag ${tag} already points to ${tagSha}, not ${sha}; publishing would keep that commit`);
  }
  const drafts = sameTag.filter((release) => release.draft);
  const stale = drafts.filter((release) => release.target_commitish !== sha);
  if (mode === "prepare") return { delete: stale.map((release) => release.id) };
  if (mode === "check") {
    if (stale.length) throw new Error(`Draft ${tag} targets ${stale[0].target_commitish}, not ${sha}`);
    if (drafts.length !== 1) throw new Error(`Expected one draft for ${tag}, found ${drafts.length}`);
    return { delete: [] };
  }
  throw new Error(`Unknown mode: ${mode}`);
}

async function main([mode, repository, tag, sha]) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GH_TOKEN or GITHUB_TOKEN is required");
  const api = async (path, { method = "GET", allowMissing = false } = {}) => {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      method,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  };

  const releases = await api("/releases?per_page=100");
  let ref = (await api(`/git/ref/tags/${encodeURIComponent(tag)}`, { allowMissing: true }))?.object;
  if (ref?.type === "tag") ref = (await api(`/git/tags/${ref.sha}`)).object;
  const plan = planReleaseDraft({ mode, releases, tag, tagSha: ref?.sha, sha });
  for (const id of plan.delete) {
    const draft = releases.find((release) => release.id === id);
    await api(`/releases/${id}`, { method: "DELETE" });
    console.log(`Deleted draft ${tag} left by ${draft.target_commitish}; this run targets ${sha}`);
  }
  if (mode === "check") console.log(`Draft ${tag} targets ${sha}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { load as loadYaml } from "js-yaml";
import lockfile from "proper-lockfile";
import { componentRepositories, rootDir } from "./release-components.mjs";

const repository = componentRepositories["pi-agent-desktop"];
const apiRoot = `https://api.github.com/repos/${repository}`;
const workflow = "release.yml";
const git = (...args) => execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();

export function chooseRun(runs, sha) {
  return runs.filter((run) => run.head_sha === sha && run.event === "workflow_dispatch")
    .sort((a, b) => b.id - a.id)[0];
}

export function validateAssets(release, version) {
  assert.equal(release.tag_name, `v${version}`, "Unexpected release version");
  assert.equal(release.draft, false, "Release is still a draft");
  assert.equal(release.prerelease, false, "Release is a prerelease");
  const names = [
    `Pi.Agent_${version}_aarch64.dmg`,
    `Pi.Agent_${version}_aarch64.app.tar.gz`,
    `Pi.Agent_${version}_aarch64.app.tar.gz.sig`,
    `Pi.Agent_${version}_amd64.deb`,
    `Pi.Agent_${version}_amd64.deb.sig`,
    `Pi.Agent_${version}_x64-setup.exe`,
    `Pi.Agent_${version}_x64-setup.exe.sig`,
    "latest.json", "component-versions.json",
  ];
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  for (const name of names) {
    const asset = assets.get(name);
    assert.ok(asset?.state === "uploaded" && asset.size > 0, `Missing or incomplete asset: ${name}`);
  }
  return assets;
}

export function validateUpdate(update, assets, version) {
  assert.equal(update.version.replace(/^v/, ""), version, "Updater version mismatch");
  for (const target of ["darwin-aarch64", "linux-x86_64", "windows-x86_64"]) {
    assert.ok(update.platforms?.[target], `Missing updater target: ${target}`);
  }
  return Object.entries(update.platforms).map(([target, entry]) => {
    const asset = [...assets.values()].find((asset) =>
      entry.url === asset.url || entry.url === asset.browser_download_url);
    assert.ok(asset, `Updater ${target} points outside this release`);
    const expected = target.startsWith("darwin-aarch64") ? `Pi.Agent_${version}_aarch64.app.tar.gz`
      : target.startsWith("linux-x86_64") ? `Pi.Agent_${version}_amd64.deb`
        : target.startsWith("windows-x86_64") ? `Pi.Agent_${version}_x64-setup.exe` : null;
    assert.equal(asset.name, expected, `Wrong installer for ${target}`);
    assert.ok(typeof entry.signature === "string" && entry.signature.trim(), `Missing signature: ${target}`);
    assert.ok(assets.has(`${asset.name}.sig`), `Missing signature file: ${target}`);
    return { target, asset, signature: entry.signature };
  });
}

async function credentials() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) return token;
  try {
    const record = loadYaml(await readFile("/ssd/appdata/secrets/github_cheneyveron.yaml", "utf8"));
    if (typeof record?.pi_agent_telepi_pat === "string" && record.pi_agent_telepi_pat) {
      return record.pi_agent_telepi_pat;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Cannot read the GitHub credential record");
  }
  throw new Error("Set GH_TOKEN or configure pi_agent_telepi_pat in the Hermes credential record");
}

async function main() {
  const flags = new Set(process.argv.slice(2));
  const allowed = ["--verify-only", "--no-wait", "--retry-failed", "--help"];
  for (const flag of flags) if (!allowed.includes(flag)) throw new Error(`Unknown option: ${flag}`);
  if (flags.has("--help")) {
    console.log("npm run desktop:release -- [--no-wait | --verify-only | --retry-failed]\nDefault: publish the committed version on origin/main, wait and verify.\n--no-wait: start/resume and print the Actions URL.\n--verify-only: verify the current version's published assets.\n--retry-failed: explicitly rerun failed jobs for this commit.");
    return;
  }
  if (flags.has("--verify-only") && (flags.has("--no-wait") || flags.has("--retry-failed"))) {
    throw new Error("--verify-only cannot be combined with publishing options");
  }
  const token = await credentials();
  async function api(path, { method = "GET", body, allowMissing = false } = {}) {
    const response = await fetch(path.startsWith("https:") ? path : apiRoot + path, {
      method,
      headers: {
        Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${new URL(response.url).pathname}: HTTP ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  const manifest = JSON.parse(await readFile(join(rootDir, "src-tauri/resources/component-versions.json"), "utf8"));
  const version = JSON.parse(await readFile(join(rootDir, "src-tauri/pi-agent-desktop-package.json"), "utf8")).version;
  assert.equal(manifest.appVersion, version, "Local component manifest version mismatch");
  async function verify(expectedSha) {
    const release = await api(`/releases/tags/v${version}`);
    const assets = validateAssets(release, version);
    const cache = new Map();
    async function download(name) {
      if (!cache.has(name)) {
        const response = await fetch(assets.get(name).browser_download_url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Download ${name}: HTTP ${response.status}`);
        cache.set(name, await response.text());
      }
      return cache.get(name);
    }
    assert.deepEqual(JSON.parse(await download("component-versions.json")), manifest, "Published component manifest mismatch");
    const update = JSON.parse(await download("latest.json"));
    for (const { target, asset, signature } of validateUpdate(update, assets, version)) {
      assert.equal(signature.trim(), (await download(`${asset.name}.sig`)).trim(), `Signature mismatch: ${target}`);
    }
    const latest = await api("/releases/latest");
    assert.equal(latest.id, release.id, "This version is not the latest stable release");
    if (expectedSha) {
      let ref = (await api(`/git/ref/tags/v${version}`)).object;
      if (ref.type === "tag") ref = (await api(`/git/tags/${ref.sha}`)).object;
      assert.equal(ref.sha, expectedSha, "Release tag points to another commit");
    }
    console.log(`Verified ${version}: all installers, signatures, component manifest and updater targets.\n${release.html_url}`);
  }
  if (flags.has("--verify-only")) return verify();

  assert.equal(git("branch", "--show-current"), "main", "Publish from main");
  assert.equal(git("status", "--porcelain"), "", "Commit and push your changes before publishing");
  const remote = git("remote", "get-url", "origin");
  assert.ok(/[:/]cheneyveron\/pi-agent-desktop(?:\.git)?$/.test(remote), "origin must point to cheneyveron/pi-agent-desktop");
  const identity = await api("https://api.github.com/user");
  assert.equal(identity.login, "cheneyveron", "Select the cheneyveron GitHub identity");
  assert.ok((await api("")).permissions?.push, "GitHub token needs repository write permission");
  const sha = git("rev-parse", "HEAD");
  assert.equal((await api("/commits/main")).sha, sha, "Push main before publishing");
  execFileSync(process.execPath, [join(rootDir, "scripts/verify-release-components.mjs")], {
    cwd: rootDir, stdio: "inherit", env: { ...process.env, GITHUB_TOKEN: token },
  });
  const released = await api(`/releases/tags/v${version}`, { allowMissing: true });
  if (released && !released.draft) {
    console.log(`Version ${version} is already published; verifying it without dispatching again. Bump the version before a new release.`);
    return verify();
  }
  const unlock = await lockfile.lock(rootDir, {
    lockfilePath: join(git("rev-parse", "--absolute-git-dir"), "desktop-release.lock"),
    stale: 120_000,
  });
  const deadline = Date.now() + 90 * 60_000;
  try {
    const runs = () => api(`/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=100`);
    const existingRuns = (await runs()).workflow_runs;
    const otherActive = existingRuns.find((run) => run.status !== "completed" && run.head_sha !== sha);
    if (otherActive) throw new Error(`Another commit is being released; wait for it first: ${otherActive.html_url}`);
    let run = chooseRun(existingRuns, sha);
    if (run?.status === "completed" && run.conclusion !== "success") {
      if (!flags.has("--retry-failed")) throw new Error(`Release failed: ${run.html_url}\nRun with --retry-failed to retry failed jobs.`);
      await api(`/actions/runs/${run.id}/rerun-failed-jobs`, { method: "POST" });
      console.log(`Retrying failed jobs: ${run.html_url}`);
      // Wait for the rerun to replace the old completed state.
      const attempt = run.run_attempt;
      do {
        await delay(5000);
        run = await api(`/actions/runs/${run.id}`);
        if (Date.now() > deadline) throw new Error(`Timed out: ${run.html_url}`);
      } while (run.run_attempt === attempt && run.status === "completed");
    } else if (!run) {
      assert.equal((await api("/commits/main")).sha, sha, "Remote main changed during preflight; update your checkout first");
      await api(`/actions/workflows/${workflow}/dispatches`, { method: "POST", body: { ref: "main" } });
      console.log(`Started signed release ${version} at ${sha.slice(0, 7)}`);
      while (!run) {
        await delay(5000);
        run = chooseRun((await runs()).workflow_runs, sha);
        if (Date.now() > deadline) throw new Error("Timed out finding the dispatched run; check GitHub Actions before retrying");
      }
    }
    console.log(run.html_url);
    if (flags.has("--no-wait")) return;
    let previous = "";
    while (true) {
      run = await api(`/actions/runs/${run.id}`);
      const jobs = (await api(`/actions/runs/${run.id}/jobs`)).jobs;
      const status = jobs.map((job) => `${job.name}: ${job.conclusion ?? job.status}${job.steps?.some((step) => step.status === "in_progress") ? ` — ${job.steps.find((step) => step.status === "in_progress").name}` : ""}`).join("\n");
      if (status !== previous) { console.log(status); previous = status; }
      if (run.status === "completed") {
        if (run.conclusion !== "success") throw new Error(`Release ${run.conclusion}: ${run.html_url}\nDraft remains unpublished. Use --retry-failed after fixing the failure.`);
        break;
      }
      if (Date.now() > deadline) throw new Error(`Timed out; the remote build continues. Run this script again to resume: ${run.html_url}`);
      await delay(20_000);
    }
    await verify(sha);
  } finally { await unlock(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

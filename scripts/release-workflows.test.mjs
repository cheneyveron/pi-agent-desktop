import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const readText = async (...args) => (await readFile(...args)).replace(/\r\n/g, "\n");

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const componentUpdates = await readText(
  join(root, ".github", "workflows", "component-updates.yml"),
  "utf8",
);

test("component updates are manual-only with the permissions the sync needs", () => {
  assert.match(componentUpdates, /on:\s*\n\s*workflow_dispatch:/);
  assert.doesNotMatch(componentUpdates, /schedule:/);
  assert.doesNotMatch(componentUpdates, /actions: write/);
  assert.match(componentUpdates, /contents: write/);
  assert.match(componentUpdates, /pull-requests: write/);
  assert.match(componentUpdates, /issues: write/);
  assert.doesNotMatch(componentUpdates, /codex\/component-updates/);
});

test("the boundary is classified before the merge, not after", () => {
  // Once a merge commit exists the incoming changeset can no longer be
  // recovered with a plain diff, so ordering here is load-bearing.
  const classifyAt = componentUpdates.indexOf("fork-ownership.mjs classify");
  const mergeAt = componentUpdates.indexOf("git merge --no-edit --no-ff");
  assert.ok(classifyAt > -1, "sync must classify the upstream changeset");
  assert.ok(mergeAt > -1, "sync must still merge the upstream tag");
  assert.ok(classifyAt < mergeAt, "classification must run before the merge");
});

test("a manually requested direct sync is gated on the fork boundary", () => {
  // A clean merge into a fork-modified file can be a silent semantic conflict,
  // so only a no-overlap sync may reach a signed release without review.
  assert.match(
    componentUpdates,
    /steps\.boundary\.outputs\.review_required != 'true'[\s\S]{0,400}git push origin HEAD:main/,
  );
  const reviewStep = componentUpdates.slice(componentUpdates.indexOf("Open a review PR"));
  assert.match(reviewStep, /steps\.boundary\.outputs\.review_required == 'true'/);
  assert.match(reviewStep, /gh pr create/);
  assert.doesNotMatch(componentUpdates, /gh workflow run release\.yml/);
});

test("the signed release workflow is manual-only", async () => {
  const release = await readText(join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.match(release, /on:\s*\n\s*workflow_dispatch:/);
  assert.doesNotMatch(release, /\bpush:/);
});

test("the merge gate covers tests, types, lint and a real build", () => {
  assert.match(componentUpdates, /npm test/);
  assert.match(componentUpdates, /tsc --noEmit/);
  assert.match(componentUpdates, /npm run lint/);
  assert.match(componentUpdates, /PI_WEB_DESKTOP_BUILD=1 node_modules\/\.bin\/next build/);
});

test("npm test covers every test directory, recursively", async () => {
  // Upstream ships components/*.test.mjs covering fork-modified files, and the
  // sync gate once ran only lib/ and scripts/, silently skipping them nightly.
  // The globs must recurse too: a flat components/*.test.mjs skips the
  // fork-owned tests under components/desktop/.
  const pkg = JSON.parse(await readText(join(root, "package.json"), "utf8"));
  assert.doesNotMatch(pkg.scripts.test, /'[^']*\.test\.mjs'/, "Windows cmd passes single quotes literally, silently running zero tests");
  for (const dir of ["app", "lib", "scripts", "components", "hooks"]) {
    assert.match(
      pkg.scripts.test,
      new RegExp(`${dir}/\\*\\*/\\*\\.test\\.mjs`),
      `npm test must recurse into ${dir}/`,
    );
  }
});

test("no test file is left out of npm test", async () => {
  // Catches a test added in a directory the globs do not cover.
  const { execFileSync } = await import("node:child_process");
  const tracked = execFileSync("git", ["ls-files", "*.test.mjs"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

  const covered = tracked.filter((file) => /^(app|lib|scripts|components|hooks|public)\//.test(file));
  assert.deepEqual(
    tracked.filter((file) => !covered.includes(file)),
    [],
    "a .test.mjs file lives outside app/, lib/, scripts/, components/, hooks/ and public/ — extend npm test",
  );
});

test("a sync already awaiting review is skipped, not retried nightly", () => {
  // needs_update stays true while a review PR is open, so without this guard
  // the job would rebuild and collide with its own branch every night — and
  // file a failure issue each time.
  assert.match(componentUpdates, /gh pr list[\s\S]{0,160}--head "sync\/pi-web-\$PI_WEB_TAG"/);
  assert.match(componentUpdates, /awaiting_review=true/);

  const gated = componentUpdates
    .split("\n")
    .filter((line) => line.trimStart().startsWith("if: steps.releases.outputs.needs_update"));
  assert.ok(gated.length >= 3, "expected the sync/verify/publish steps to be gated");
  for (const line of gated) {
    assert.match(line, /steps\.pending\.outputs\.awaiting_review != 'true'/);
  }
});

test("a failed sync is reported instead of failing silently", () => {
  assert.match(componentUpdates, /if: failure\(\)/);
  assert.match(componentUpdates, /gh issue create/);
  assert.match(componentUpdates, /component-sync-failure/);
});

test("failure alerts do not depend on Issues being enabled", async () => {
  // This repository has Issues disabled, so the original issue-only alerts
  // failed silently and reported nothing at all. The job summary always works.
  const release = await readText(join(root, ".github", "workflows", "release.yml"), "utf8");

  for (const [name, workflow] of [["component-updates", componentUpdates], ["release", release]]) {
    assert.match(workflow, /GITHUB_STEP_SUMMARY/, `${name} must always write a job summary`);
    assert.match(
      workflow,
      /has_issues/,
      `${name} must check whether Issues are enabled before using them`,
    );
  }
});

test("the pi package list is derived, never hand-written in the workflow", () => {
  assert.match(componentUpdates, /scripts\/pi-packages\.mjs --install-spec/);
  assert.doesNotMatch(componentUpdates, /@earendil-works\/pi-coding-agent@/);
  assert.doesNotMatch(componentUpdates, /@earendil-works\/pi-tui@/);
});

test("history is never rewritten on main", () => {
  // --force-with-lease on the disposable sync branch is fine; a bare --force
  // anywhere, or any force push to main, is not.
  assert.doesNotMatch(componentUpdates, /--force(?!-with-lease)/);
  assert.doesNotMatch(componentUpdates, /push .*--force-with-lease origin HEAD:main/);
});

test("a failed release build is reported instead of failing silently", async () => {
  // Four consecutive v0.1.3 builds failed on Windows with no notification, and
  // the draft was published by hand with macOS artifacts and no manifest.
  const workflow = await readText(join(root, ".github", "workflows", "release.yml"), "utf8");

  assert.match(workflow, /if: failure\(\)/);
  assert.match(workflow, /gh issue create/);
  assert.match(workflow, /release-failure/);
  assert.match(workflow, /needs: \[build, manifest\]/);
});

test("the manifest job only publishes when every platform succeeded", async () => {
  // `needs: build` covers the whole matrix, so one failed platform keeps the
  // release a draft. Publishing a release that is missing a platform's
  // installer or its component manifest breaks updates for that platform.
  const workflow = await readText(join(root, ".github", "workflows", "release.yml"), "utf8");
  const manifestJob = workflow.slice(workflow.indexOf("\n  manifest:"), workflow.indexOf("\n  notify:"));

  assert.match(manifestJob, /needs: build/);
  assert.doesNotMatch(manifestJob, /if: (always|success\(\) \|\|)/);
  assert.match(manifestJob, /--draft=false --latest --prerelease=false/);
});

test("release workflow publishes Apple Silicon, Linux x64, and Windows x64 installers", async () => {
  const workflow = await readText(
    join(root, ".github", "workflows", "release.yml"),
    "utf8",
  );

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /max-parallel: 1/);
  assert.match(workflow, /runner: macos-26/);
  // Linking an older SDK ships the legacy traffic lights (0.7.1).
  assert.match(workflow, /--show-sdk-version\)"\n\s+echo "macOS SDK \$sdk"\n\s+test "\$\{sdk%%\.\*\}" -ge 26/);
  assert.match(workflow, /target: aarch64-apple-darwin/);
  assert.match(workflow, /runner: ubuntu-24\.04/);
  assert.match(workflow, /target: x86_64-unknown-linux-gnu/);
  assert.match(workflow, /--bundles deb/);
  assert.match(workflow, /libwebkit2gtk-4\.1-dev/);
  assert.match(workflow, /libayatana-appindicator3-dev/);
  assert.match(workflow, /runner: windows-latest/);
  assert.match(workflow, /target: x86_64-pc-windows-msvc/);
  assert.match(workflow, /--bundles nsis/);
  assert.doesNotMatch(workflow, /x86_64-apple-darwin/);
  assert.doesNotMatch(workflow, /macos-15/);
  assert.match(workflow, /uploadUpdaterJson: true/);
  assert.match(workflow, /gh release edit "v\$version" --draft=false --latest --prerelease=false/);
});

test("nothing reintroduces a literal homedir() into an fs call", async () => {
  // This is what broke the Windows build for every release: @vercel/nft folds
  // homedir() at build time and globs the whole user profile, which dies on the
  // profile's junction loops. lib/user-home.ts exists to keep it dynamic.
  const guarded = [
    "lib/file-access.ts",
    "lib/directory-browser.ts",
    "lib/skill-lock.ts",
    "app/api/cwd/validate/route.ts",
    "lib/default-cwd.ts",
    "lib/enabled-models-runtime.ts",
    "lib/linked-directory.ts",
    "app/api/skills/route.ts",
    "lib/chat-workspace-policy.ts",
    "lib/chat-file-access.ts",
  ];

  for (const file of guarded) {
    const source = await readText(join(root, file), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.doesNotMatch(
      code,
      /\bhomedir\s*\(/,
      `${file} calls homedir() directly — use userHome() from lib/user-home.ts instead`,
    );
    assert.match(code, /userHome\s*\(/, `${file} should resolve the home directory via userHome()`);
  }
});

test("the Windows debug workflow cannot release or sign anything", async () => {
  const workflow = await readText(
    join(root, ".github", "workflows", "windows-build-debug.yml"),
    "utf8",
  );

  // Manual only, and it must never touch signing keys or create a release.
  assert.match(workflow, /on:\s*\n\s*workflow_dispatch:/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.doesNotMatch(workflow, /tauri-action/);
  assert.doesNotMatch(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.doesNotMatch(workflow, /gh release/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /trace-stray-scandir\.cjs/);
});

test("desktop staging ships node-pty native prebuilds with executable helpers", async () => {
  const prepareSource = await readText(new URL("./prepare-desktop.mjs", import.meta.url), "utf8");
  // Next's tracer cannot follow node-pty's runtime-computed prebuilds path;
  // staging must copy the tree and fix the macOS spawn-helper bits for both
  // darwin variants (a staged build may run on either architecture).
  assert.match(prepareSource, /node_modules", "node-pty"\)/);
  assert.match(prepareSource, /\["darwin-arm64", "darwin-x64"\]/);
  assert.match(prepareSource, /chmod\(join\(ptyDestination, "prebuilds", variant, "spawn-helper"\), 0o755\)/);
});

test("desktop staging ships the Amazon Bedrock SDK the file tracer cannot see", async () => {
  const prepareSource = await readText(new URL("./prepare-desktop.mjs", import.meta.url), "utf8");
  // bedrock-converse-stream.lazy.js imports through a variable specifier on
  // purpose, so Next never traces @aws-sdk/client-bedrock-runtime into the
  // standalone server. Packaging must stage that closure itself.
  assert.match(prepareSource, /bedrock-converse-stream\.js/);
  assert.match(prepareSource, /stageResolvedClosure\(/);
  assert.match(prepareSource, /@aws-sdk\/client-bedrock-runtime/);
  assert.match(prepareSource, /@smithy\/node-http-handler/);
  assert.match(prepareSource, /http-proxy-agent/);
  assert.match(prepareSource, /https-proxy-agent/);
});

test("the Tauri crates stay on the npm packages' major/minor", async () => {
  // `tauri build` aborts six minutes into every platform of a signed release
  // with "Found version mismatched Tauri packages" when a `tauri-plugin-*`
  // crate and its `@tauri-apps/plugin-*` npm package (or `tauri` and
  // `@tauri-apps/api`) sit on different major/minor releases. v0.4.7 died
  // exactly this way: the component sync ran a plain `npm install`, which
  // re-resolved the caret ranges to plugin-updater 2.12.0 / plugin-notification
  // 2.4.0 while Cargo.lock kept 2.10.1 / 2.3.3. Both halves are committed
  // files, so the comparison the CLI performs belongs in this suite rather than
  // on three runners.
  const cargoLock = await readText(join(root, "src-tauri", "Cargo.lock"), "utf8");
  const npmLock = JSON.parse(await readText(join(root, "package-lock.json"), "utf8"));
  const release = (version) => version.split(".").slice(0, 2).join(".");

  const crateVersions = new Map();
  for (const [, name, version] of cargoLock.matchAll(
    /\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g,
  )) {
    crateVersions.set(name, version);
  }

  const npmVersions = new Map();
  for (const [path, entry] of Object.entries(npmLock.packages)) {
    const name = path.match(/(?:^|\/)node_modules\/(@tauri-apps\/[^/]+)$/)?.[1];
    if (!name) continue;
    npmVersions.set(name, [...(npmVersions.get(name) ?? []), entry.version]);
  }

  // Same pairing and the same skip rule as the CLI: a crate without an npm twin
  // (tauri-plugin-fs here) is not compared, only what both sides install.
  const pairs = [["tauri", "@tauri-apps/api"]];
  for (const crate of crateVersions.keys()) {
    if (crate.startsWith("tauri-plugin-")) {
      pairs.push([crate, `@tauri-apps/plugin-${crate.slice("tauri-plugin-".length)}`]);
    }
  }

  const mismatched = [];
  for (const [crate, npm] of pairs) {
    const crateVersion = crateVersions.get(crate);
    if (!crateVersion || !npmVersions.has(npm)) continue;
    for (const npmVersion of npmVersions.get(npm)) {
      if (release(crateVersion) !== release(npmVersion)) {
        mismatched.push(`${crate} (v${crateVersion}) : ${npm} (v${npmVersion})`);
      }
    }
  }

  assert.deepEqual(
    mismatched,
    [],
    "align them in src-tauri/Cargo.lock (cargo update -p <crate> --precise <version>)",
  );
});

test("the server image is published to GHCR only after the Release is published", async () => {
  const release = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");
  const image = await readFile(join(root, ".github", "workflows", "docker-image.yml"), "utf8");

  const job = release.slice(release.indexOf("\n  image:"), release.indexOf("\n  # A partially failed matrix"));
  assert.match(job, /needs: manifest/);
  assert.match(job, /uses: \.\/\.github\/workflows\/docker-image\.yml/);
  assert.match(job, /packages: write/);
  // `manifest` flips the draft to published; an image must never precede it.
  assert.ok(release.indexOf("gh release edit") < release.indexOf("\n  image:"));

  assert.match(image, /workflow_call:/);
  assert.match(image, /workflow_dispatch:/);
  assert.match(image, /ghcr\.io\/cheneyveron\/pi-agent-desktop/);
  assert.match(image, /password: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(image, /\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/, "the version input is validated");
  assert.match(image, /ref: v\$\{\{ inputs\.version \}\}/, "the image is built from the release tag");
  assert.match(image, /:\$\{\{ inputs\.version \}\}/);
  assert.match(image, /:latest/);
  const triggers = image.slice(image.indexOf("\non:"), image.indexOf("\npermissions:"));
  assert.doesNotMatch(triggers, /\bpull_request\b|\bpush:/, "the image is never built from a branch push");
});

test("the image Dockerfile builds the web server and carries the repository label", async () => {
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  assert.match(dockerfile, /RUN npm run build/);
  assert.match(dockerfile, /org\.opencontainers\.image\.source="https:\/\/github\.com\/cheneyveron\/pi-agent-desktop"/);
  assert.match(dockerfile, /^USER node$/m);
});

test("the release notes describe only the version being released", async () => {
  const release = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");
  const version = JSON.parse(await readFile(join(root, "src-tauri", "pi-agent-desktop-package.json"), "utf8")).version;
  const body = release.slice(release.indexOf("releaseBody: |"), release.indexOf("releaseDraft:"));
  const headings = [...body.matchAll(/^\s*## Pi Agent Desktop (\S+)/gm)].map((match) => match[1]);
  assert.ok(headings.length > 0);
  assert.deepEqual([...new Set(headings)], [version], "replace the notes on each release, do not prepend to them");
});

test("the updater manifest is rewritten to public download URLs before publishing", async () => {
  const release = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.ok(
    release.indexOf("scripts/public-updater-urls.mjs") < release.indexOf("gh release edit"),
    "latest.json must be fixed before the draft is published",
  );
});

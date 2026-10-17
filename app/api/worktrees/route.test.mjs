import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const route = await jiti.import("./route.ts");
const fetchRoute = await jiti.import("./fetch/route.ts");

// Seed the allowed-roots cache so the route never scans the real session store.
function allowOnly(...roots) {
  globalThis.__piAllowedRootsCache = { roots: new Set(roots), expiresAt: Date.now() + 60_000 };
}

function call(handler, method, body) {
  return handler(new Request("http://localhost/api/worktrees", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

async function tempRepo(t) {
  // realpath: macOS tmpdir is a symlink and git reports real paths.
  const parent = realpathSync(await mkdtemp(path.join(os.tmpdir(), "pi-web-worktrees-route-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const repo = path.join(parent, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  await writeFile(path.join(repo, "README.md"), "hi\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return { parent, repo };
}

test("every method refuses a cwd outside the allowed roots before running git", async (t) => {
  const { repo } = await tempRepo(t);
  allowOnly(path.join(os.tmpdir(), "somewhere-else"));

  const list = await route.GET(new Request(`http://localhost/api/worktrees?cwd=${encodeURIComponent(repo)}`));
  assert.equal(list.status, 403);
  assert.equal((await call(route.POST, "POST", { cwd: repo, branch: "feature" })).status, 403);
  assert.equal((await call(route.PUT, "PUT", { cwd: repo, branch: "main" })).status, 403);
  assert.equal((await call(route.DELETE, "DELETE", { cwd: repo, path: repo })).status, 403);
  assert.equal((await call(fetchRoute.POST, "POST", { cwd: repo })).status, 403);
  assert.equal(existsSync(`${repo}-worktrees`), false);
});

test("missing fields answer 400", async () => {
  allowOnly();
  assert.equal((await route.GET(new Request("http://localhost/api/worktrees"))).status, 400);
  assert.equal((await call(route.POST, "POST", { branch: "x" })).status, 400);
  assert.equal((await call(route.POST, "POST", { cwd: "/tmp" })).status, 400);
  assert.equal((await call(route.PUT, "PUT", { cwd: "/tmp", branch: 3 })).status, 400);
  assert.equal((await call(route.DELETE, "DELETE", { cwd: "/tmp" })).status, 400);
});

test("create, list, switch and remove a worktree inside an allowed repo", async (t) => {
  const { repo } = await tempRepo(t);
  allowOnly(repo);

  const created = await call(route.POST, "POST", { cwd: repo, branch: "feature/x" });
  assert.equal(created.status, 200);
  const { path: worktreePath, branch } = await created.json();
  assert.equal(branch, "feature/x");
  assert.equal(path.dirname(worktreePath), `${repo}-worktrees`);
  assert.equal(git(worktreePath, "branch", "--show-current"), "feature/x");

  const listed = await route.GET(new Request(`http://localhost/api/worktrees?cwd=${encodeURIComponent(repo)}&branches=1`));
  assert.equal(listed.status, 200);
  const listing = await listed.json();
  assert.equal(listing.isGit, true);
  assert.deepEqual(listing.worktrees.map((w) => w.path).sort(), [repo, worktreePath].sort());
  assert.ok(listing.branches.includes("main"));

  // Switching the main checkout in place, and refusing an option-like name.
  git(repo, "branch", "other");
  const switched = await call(route.PUT, "PUT", { cwd: repo, branch: "other" });
  assert.equal(switched.status, 200);
  assert.equal(git(repo, "branch", "--show-current"), "other");
  const optionLike = await call(route.PUT, "PUT", { cwd: repo, branch: "--orphan=evil" });
  assert.equal(optionLike.status, 400);
  assert.equal(git(repo, "branch", "--show-current"), "other");

  // A dirty worktree needs force; the main worktree is never removable.
  await writeFile(path.join(worktreePath, "dirty.txt"), "x");
  const dirty = await call(route.DELETE, "DELETE", { cwd: repo, path: worktreePath });
  assert.equal(dirty.status, 409);
  assert.equal((await dirty.json()).dirty, true);
  const forced = await call(route.DELETE, "DELETE", { cwd: repo, path: worktreePath, force: true });
  assert.equal(forced.status, 200);
  assert.equal(existsSync(worktreePath), false);

  const main = await call(route.DELETE, "DELETE", { cwd: repo, path: repo, force: true });
  assert.equal(main.status, 400);
  assert.equal(existsSync(path.join(repo, "README.md")), true);
});

test("remove refuses a path that is not a worktree of the repository", async (t) => {
  const { repo, parent } = await tempRepo(t);
  allowOnly(repo);
  const stranger = path.join(parent, "stranger");
  execFileSync("git", ["init", "-q", stranger]);

  const response = await call(route.DELETE, "DELETE", { cwd: repo, path: stranger, force: true });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Not a worktree of this repository/);
  assert.equal(existsSync(stranger), true);
});

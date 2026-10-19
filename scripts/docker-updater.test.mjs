import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../deploy/docker/updater.sh", import.meta.url));
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

// A stand-in `docker` that records each call and answers the health probe.
function setup(t, { health = "healthy", pullFails = false, upFails = false, tag = "0.7.4" } = {}) {
  const base = mkdtempSync(join(tmpdir(), "pi-updater-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bin = join(base, "bin");
  const project = join(base, "project");
  const dir = join(base, "updater");
  for (const path of [bin, project, dir]) mkdirSync(path);
  const calls = join(base, "calls.log");
  const envFile = join(project, ".env");
  writeFileSync(join(bin, "docker"), `#!/bin/sh
echo "tag=\${PI_AGENT_TAG:-} $*" >> ${JSON.stringify(calls)}
case "$*" in
  *" pull "*) ${pullFails ? "exit 1" : "exit 0"} ;;
  *" up "*) ${upFails ? "exit 1" : "exit 0"} ;;
  *" ps -q "*) echo cid123 ;;
  *Config.Image*) echo "ghcr.io/x/y:$(sed -n 's/^PI_AGENT_TAG=//p' ${JSON.stringify(envFile)})" ;;
  inspect*) echo ${health} ;;
esac
exit 0
`);
  chmodSync(join(bin, "docker"), 0o755);
  writeFileSync(join(project, "compose.yaml"), "services: {}\n");
  if (tag) writeFileSync(join(project, ".env"), `OTHER=1\nPI_AGENT_TAG=${tag}\n`);

  const run = (request) => {
    if (request !== undefined) writeFileSync(join(dir, "request"), request);
    return spawnSync("sh", [script], {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        UPDATER_DIR: dir,
        PROJECT_DIR: project,
        UPDATER_ONCE: "1",
        POLL_SECONDS: "1",
        HEALTH_TIMEOUT: "2",
      },
    });
  };
  return { run, dir, project, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8") : "") };
}

test("pulls the requested tag, recreates only the web service and records the tag", (t) => {
  const s = setup(t);
  const result = s.run(`id=${ID}\nversion=0.7.5\n`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(s.dir, "status"), "utf8"), /^id=.*\nphase=done\nversion=0.7.5\n$/);
  assert.equal(existsSync(join(s.dir, "request")), false);
  assert.equal(readFileSync(join(s.project, ".env"), "utf8"), "OTHER=1\nPI_AGENT_TAG=0.7.5\n");
  const calls = s.calls();
  assert.match(calls, /tag=0\.7\.5 compose .* pull web/);
  assert.match(calls, /compose .* up -d --no-deps --no-build web/);
});

test("rolls back to the previous tag when the new container is unhealthy", (t) => {
  const s = setup(t, { health: "unhealthy" });
  s.run(`id=${ID}\nversion=0.7.5\n`);
  const status = readFileSync(join(s.dir, "status"), "utf8");
  assert.match(status, /phase=failed/);
  assert.match(status, /rolled back to 0\.7\.4/);
  assert.match(readFileSync(join(s.project, ".env"), "utf8"), /PI_AGENT_TAG=0\.7\.4/);
  assert.equal(s.calls().match(/up -d/g).length, 2);
});

test("a failed pull changes nothing", (t) => {
  const s = setup(t, { pullFails: true });
  s.run(`id=${ID}\nversion=0.7.5\n`);
  const status = readFileSync(join(s.dir, "status"), "utf8");
  assert.match(status, /phase=failed/);
  assert.match(status, /error=Could not pull image 0\.7\.5\. Is it published yet\?\n$/);
  assert.match(readFileSync(join(s.project, ".env"), "utf8"), /PI_AGENT_TAG=0\.7\.4/);
  assert.doesNotMatch(s.calls(), /up -d/);
});

test("rejects versions that are not plain x.y.z before touching Docker", (t) => {
  for (const version of ["latest", "0.7.5; rm -rf /", "../0.7.5", "0.7.5-rc.1", ""]) {
    const s = setup(t);
    s.run(`id=${ID}\nversion=${version}\n`);
    assert.match(readFileSync(join(s.dir, "status"), "utf8"), /phase=failed/);
    assert.equal(s.calls(), "");
  }
});

test("ignores a request without a valid id", (t) => {
  const s = setup(t);
  s.run("id=nope\nversion=0.7.5\n");
  assert.equal(existsSync(join(s.dir, "status")), false);
  assert.equal(s.calls(), "");
});

test("does not guess a rollback target when no tag is recorded", (t) => {
  const s = setup(t, { health: "unhealthy", tag: "" });
  s.run(`id=${ID}\nversion=0.7.5\n`);
  assert.match(readFileSync(join(s.dir, "status"), "utf8"), /no previous tag/);
});

test("a failed `compose up` is not mistaken for success by the old healthy container", (t) => {
  const s = setup(t, { upFails: true });
  s.run(`id=${ID}\nversion=0.7.5\n`);
  const status = readFileSync(join(s.dir, "status"), "utf8");
  assert.match(status, /phase=failed/);
  assert.match(status, /not started/);
  assert.match(readFileSync(join(s.project, ".env"), "utf8"), /PI_AGENT_TAG=0\.7\.4/);
});

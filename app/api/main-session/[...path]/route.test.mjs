import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { GET } = await jiti.import("./route.ts");
const { startServer } = await import("../../../../main-session/server.ts");

const ctx = (...path) => ({ params: Promise.resolve({ path }) });
const get = (path, ...parts) => GET(new Request(`http://127.0.0.1:30141/api/main-session/${path}`), ctx(...parts));

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("a stopped service: /health is a 200 {ok:false}, other paths are 503", async () => {
  process.env.MAIN_SESSION_PORT = String(await freePort());
  const health = await get("health", "health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: false, running: false });
  const tasks = await get("tasks?status=need", "tasks");
  assert.equal(tasks.status, 503);
  assert.equal((await tasks.json()).running, false);
});

test("a running service: responses pass through, query and SSE included", async () => {
  const started = await startServer({ port: 0, dir: null, timers: false, judgeRunner: async () => "", dispatcher: async () => ({ ok: true, result: "" }), memory: { write: async () => "sent" } });
  process.env.MAIN_SESSION_PORT = String(started.port);
  try {
    const health = await get("health", "health");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    const bad = await get("digest?date=nope", "digest");
    assert.equal(bad.status, 400, "the service's status and query come through");
    const controller = new AbortController();
    const stream = await GET(new Request("http://127.0.0.1:30141/api/main-session/stream", { signal: controller.signal }), ctx("stream"));
    assert.equal(stream.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(stream.headers.get("x-accel-buffering"), "no");
    const first = new TextDecoder().decode((await stream.body.getReader().read()).value);
    assert.match(first, /event: hello/);
    controller.abort();
  } finally {
    await started.close();
  }
});

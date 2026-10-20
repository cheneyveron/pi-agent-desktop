import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Script } from 'node:vm';
import ts from 'typescript';

const source = ts.createSourceFile('useAgentSession.ts', readFileSync(new URL('./useAgentSession.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
function loadSessionWith(overrides) {
  let node;
  const find = candidate => {
    if (ts.isVariableDeclaration(candidate) && candidate.name.getText(source) === 'loadSession') node = candidate.initializer.arguments[0];
    ts.forEachChild(candidate, find);
  };
  find(source); assert.ok(node);
  const env = {
    Error, Map, URLSearchParams, encodeURIComponent, console,
    sessionIdRef: { current: 'session-a' }, sessionGenerationRef: { current: 1 },
    loadFlightsRef: { current: new Map() }, liveRunEpochRef: { current: 0 },
    setLoading() {}, setError() {}, setData() { env.applied.push('data'); }, setMessages() { env.applied.push('messages'); },
    applied: [],
    ...overrides,
  };
  return { env, run: new Script(ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText).runInNewContext(env) };
}

// A queued message is delivered the moment the previous run settles, so its run can start
// while the previous run's end-of-run transcript read is still in flight. That read predates
// the new user message; applying it would remove the bubble until the next reload.
test('a transcript read that began before a run started is not applied over that run', async () => {
  let respond;
  const { env, run } = loadSessionWith({
    fetchWithRetry: () => new Promise(resolve => { respond = resolve; }),
  });
  const read = run('session-a');
  env.liveRunEpochRef.current++; // agent_start of the delivered queued message
  respond({ status: 200, ok: true, json: async () => ({ context: { messages: [], entryIds: [] } }) });
  assert.equal(await read, null);
  assert.deepEqual(env.applied, []);
});

test('reads started in different runs never share one in-flight request', async () => {
  const requests = [];
  const { env, run } = loadSessionWith({
    fetchWithRetry: () => new Promise(resolve => requests.push(resolve)),
  });
  void run('session-a');
  env.liveRunEpochRef.current++;
  void run('session-a');
  assert.equal(requests.length, 2);
});

test('reads inside one run still share a single request', async () => {
  const requests = [];
  const { run } = loadSessionWith({
    fetchWithRetry: () => new Promise(resolve => requests.push(resolve)),
  });
  void run('session-a');
  void run('session-a');
  assert.equal(requests.length, 1);
});

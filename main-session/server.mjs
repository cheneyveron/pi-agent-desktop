#!/usr/bin/env node
// Entry point: `npm run main-session` (or `node main-session/server.mjs`). Node 22.18+ strips
// the TypeScript types of the service modules natively; no build step.

import { startServer } from "./server.ts";

try {
  const { port, service, close } = await startServer();
  const judge = service.judge.available ? `judge on rdsec/${process.env.MAIN_SESSION_MODEL ?? "claude-haiku-5-5"}` : "judge off";
  process.stdout.write(`[main-session] listening on http://127.0.0.1:${port} (state ${service.store.dir}, ${judge})\n`);
  const stop = () => { void close().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (error) {
  if (error && error.code === "EADDRINUSE") {
    process.stderr.write(`[main-session] port ${process.env.MAIN_SESSION_PORT ?? 30180} is in use; is the main session already running?\n`);
    process.exit(2);
  }
  process.stderr.write(`[main-session] failed to start: ${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
}

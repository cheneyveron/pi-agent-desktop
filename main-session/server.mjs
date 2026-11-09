#!/usr/bin/env node
// Entry point: `npm run main-session` (or `node main-session/server.mjs`). Node 22.18+ strips
// the TypeScript types of the service modules natively; no build step.

import { startServer } from "./server.ts";

try {
  const { port, service, close } = await startServer();
  const choice = service.modelChoice();
  const judge = !service.judge.enabled
    ? "judge off"
    : choice.ref
      ? `judge on ${choice.ref}${choice.source === "env" ? " (MAIN_SESSION_MODEL)" : ""}`
      : "no model chosen: model turns paused until one is picked on the 主会话 page";
  process.stdout.write(`[main-session] listening on http://127.0.0.1:${port} (state ${service.store.dir}, ${judge})\n`);
  const stop = () => {
    // A connection or turn that will not close must not keep the process alive.
    setTimeout(() => process.exit(0), 3_000).unref();
    void close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // Started by the packaged desktop server (desktop/main-session-launcher.cjs) with an IPC
  // channel: the channel closes when that server exits for any reason, crash included.
  if (process.channel) {
    process.once("disconnect", () => {
      process.stdout.write("[main-session] parent server is gone; stopping\n");
      stop();
    });
  }
} catch (error) {
  if (error && error.code === "EADDRINUSE") {
    process.stderr.write(`[main-session] port ${process.env.MAIN_SESSION_PORT ?? 30180} is in use; is the main session already running?\n`);
    process.exit(2);
  }
  process.stderr.write(`[main-session] failed to start: ${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
}

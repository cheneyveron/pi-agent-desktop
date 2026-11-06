// Starts the main-session service: state from ~/.pi/agent/main/ (MAIN_SESSION_DIR), HTTP on
// 127.0.0.1:30180 (MAIN_SESSION_PORT). Only the loopback address is ever bound.

import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { createHandler } from "./http.ts";
import { createSdkDispatcher } from "./dispatch.ts";
import { createSdkJudgeRunner } from "./judge.ts";
import { resolveModelId } from "./pi-runtime.ts";
import { MainSessionService, type ServiceOptions } from "./service.ts";
import { Store, defaultStateDir } from "./store.ts";
import type { MainEvent, Task } from "./types.ts";

export const DEFAULT_PORT = 30180;
export const HOST = "127.0.0.1";

export interface StartOptions extends Partial<ServiceOptions> {
  port?: number;
  dir?: string | null;
  /** Seed an empty state directory from this file ({tasks, events}). */
  fixture?: string;
}

export interface Started {
  server: Server;
  service: MainSessionService;
  port: number;
  close(): Promise<void>;
}

function seed(store: Store, path: string): void {
  if (store.listTasks().length > 0 || !existsSync(path)) return;
  const data = JSON.parse(readFileSync(path, "utf8")) as { tasks?: Task[]; events?: MainEvent[] };
  for (const task of data.tasks ?? []) store.putTask(task);
  for (const event of data.events ?? []) store.addEvent(event);
}

export async function startServer(options: StartOptions = {}): Promise<Started> {
  const port = options.port ?? Number(process.env.MAIN_SESSION_PORT ?? DEFAULT_PORT);
  const store = options.store ?? new Store(options.dir === undefined ? defaultStateDir() : options.dir);
  const fixture = options.fixture ?? process.env.MAIN_SESSION_FIXTURE;
  if (fixture) seed(store, fixture);
  const modelOn = process.env.MAIN_SESSION_JUDGE !== "off";
  const modelId = modelOn ? resolveModelId() : undefined;
  const service = new MainSessionService({
    ...options,
    store,
    ...(options.judgeRunner || !modelOn ? {} : { judgeRunner: createSdkJudgeRunner({ modelId }) }),
    ...(options.dispatcher || !modelOn || process.env.MAIN_SESSION_DISPATCH === "off" ? {} : { dispatcher: createSdkDispatcher({ modelId }) }),
  });
  const server = createServer(createHandler(service));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  return {
    server, service, port: boundPort,
    close: () => new Promise<void>((resolve) => {
      service.stopTimers();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

// HTTP API of the main session (contract §3). Plain node:http, JSON in and out, bound to
// 127.0.0.1 by server.ts. Errors are `{error}` with a 4xx/5xx status.

import type { IncomingMessage, ServerResponse } from "node:http";
import { ActionError, archiveNow, continueDelivered, requireTask, undo } from "./actions.ts";
import { replay, type ReplayInput } from "./replay.ts";
import type { MainSessionService } from "./service.ts";
import type { Task } from "./types.ts";
import { decorateTask } from "./view.ts";

const MAX_BODY = 8 * 1024 * 1024;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "body must be a JSON object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "body is not valid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function openStream(service: MainSessionService, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const write = (type: string, data: unknown) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  write("hello", { since: service.since, version: service.health().version });
  const unsubscribe = service.subscribe(write);
  const heartbeat = setInterval(() => res.write(":\n\n"), 25_000);
  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", close);
  res.on("error", close);
}

export function createHandler(service: MainSessionService) {
  const view = (task: Task) => decorateTask(service.store, task);
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
    const method = req.method ?? "GET";
    try {
      const [head, id, sub] = parts;
      if (method === "GET" && head === "health" && parts.length === 1) return send(res, 200, service.health());
      if (method === "GET" && head === "stream" && parts.length === 1) return openStream(service, req, res);
      if (head === "model" && parts.length === 1) {
        if (method === "GET") return send(res, 200, service.modelChoice());
        if (method === "POST") {
          const body = await readJson(req);
          if (!("model" in body) && !("thinkingLevel" in body)) throw new HttpError(400, "model (\"provider/modelId\" or null) or thinkingLevel is required");
          let choice = "model" in body ? await service.setModel(body.model) : undefined;
          if ("thinkingLevel" in body) choice = await service.setThinkingLevel(body.thinkingLevel);
          return send(res, 200, choice);
        }
      }

      if (head === "tasks") {
        if (method === "GET" && parts.length === 1) return send(res, 200, service.listTasks(url.searchParams.get("status") ?? undefined));
        if (!id) throw new HttpError(404, "not found");
        if (method === "GET" && parts.length === 2) return send(res, 200, service.taskDetail(requireTask(service.ctx, id)));
        if (method === "POST" && parts.length === 3) {
          const body = await readJson(req);
          if (sub === "answer") {
            const result = service.answer(id, { word: String(body.word ?? ""), ...(typeof body.eventId === "string" ? { eventId: body.eventId } : {}) });
            return send(res, 200, { task: view(result.task), event: result.event });
          }
          if (sub === "archive") {
            const task = requireTask(service.ctx, id);
            if (task.status === "archived") return send(res, 200, { task: view(task) });
            const event = archiveNow(service.ctx, { task: task.id, why: typeof body.why === "string" ? body.why : "user archived", auto: false });
            return send(res, 200, { task: view(service.store.getTask(task.id) ?? task), event });
          }
          if (sub === "undo") return send(res, 200, { task: view(undo(service.ctx, id, String(body.eventId ?? ""))) });
        }
        throw new HttpError(404, "not found");
      }

      if (method === "POST" && head === "closeouts" && parts.length === 1) {
        const result = await service.intake(await readJson(req));
        return send(res, result.duplicate ? 200 : 201, { task: result.task ? view(result.task) : null, event: result.event, ...(result.duplicate ? { duplicate: true } : {}) });
      }
      if (method === "POST" && head === "seen" && parts.length === 1) {
        const body = await readJson(req);
        return send(res, 200, service.markSeen(String(body.segment ?? "")));
      }
      if (method === "GET" && head === "digest" && parts.length === 1) {
        const date = url.searchParams.get("date") ?? undefined;
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "date must be YYYY-MM-DD");
        return send(res, 200, await service.digest(date));
      }
      if (head === "chat" && parts.length === 1) {
        if (method === "GET") return send(res, 200, service.chatHistory());
        if (method === "POST") {
          const body = await readJson(req);
          const text = typeof body.text === "string" ? body.text : "";
          if (!text.trim()) throw new HttpError(400, "text is required");
          return send(res, 200, await service.chat(text));
        }
      }
      if (method === "GET" && head === "events" && parts.length === 1) {
        return send(res, 200, { events: service.store.eventsSince(url.searchParams.get("since") ?? undefined) });
      }
      if (method === "POST" && head === "sessions" && id && sub === "started" && parts.length === 3) {
        const body = await readJson(req);
        return send(res, 200, service.sessionStarted(id, typeof body.task === "string" ? body.task : undefined));
      }
      if (method === "POST" && head === "continues" && id && sub === "delivered" && parts.length === 3) {
        const body = await readJson(req);
        const event = continueDelivered(service.ctx, id, {
          ...(typeof body.sessionId === "string" && body.sessionId ? { sessionId: body.sessionId } : {}),
          ...(typeof body.error === "string" && body.error ? { error: body.error } : {}),
        });
        return send(res, 200, { ok: true, event });
      }
      if (method === "POST" && head === "replay" && parts.length === 1) {
        const body = await readJson(req);
        return send(res, 200, replay(body as unknown as ReplayInput));
      }
      throw new HttpError(404, "not found");
    } catch (error) {
      const status = error instanceof HttpError || error instanceof ActionError
        ? error.status
        : typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (status >= 500) process.stderr.write(`[main-session] ${method} ${url.pathname}: ${error instanceof Error ? error.stack : message}\n`);
      if (!res.headersSent) send(res, status, { error: message });
      else res.end();
    }
  };
}

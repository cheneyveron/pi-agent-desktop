// Listens to the main-session service's SSE stream (`GET /stream`) for
// `insert` events, which ask to put a note into an open session
// (contract §3, §4). The service may not be running: the client retries with
// a growing delay and never logs a refused connection.

export interface MainSessionInsertEvent {
  sessionId: string;
  text: string;
  task?: string;
  eventId?: string;
}

export interface SseFrame {
  event: string;
  data: string;
}

/** Complete frames in `buffer` and the unfinished rest, per the EventSource format. */
export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const normalized = buffer.replace(/\r\n?/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const frames: SseFrame[] = [];
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length) frames.push({ event, data: data.join("\n") });
  }
  return { frames, rest };
}

export function parseInsertEvent(data: string): MainSessionInsertEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.sessionId !== "string" || !raw.sessionId || typeof raw.text !== "string" || !raw.text.trim()) return undefined;
  return {
    sessionId: raw.sessionId,
    text: raw.text,
    ...(typeof raw.task === "string" && raw.task ? { task: raw.task } : {}),
    ...(typeof raw.eventId === "string" && raw.eventId ? { eventId: raw.eventId } : {}),
  };
}

export interface MainSessionStreamOptions {
  /** Service base URL, e.g. `http://127.0.0.1:30180`. */
  url: string;
  onInsert: (event: MainSessionInsertEvent) => void | Promise<void>;
  /** Each time the stream opens: the service is up. */
  onConnect?: () => void;
  fetch?: typeof fetch;
  minDelayMs?: number;
  maxDelayMs?: number;
  log?: (message: string) => void;
}

export interface MainSessionStream {
  stop(): void;
  /** Resolves once the client has stopped (tests). */
  readonly done: Promise<void>;
}

export function startMainSessionStream(options: MainSessionStreamOptions): MainSessionStream {
  const doFetch = options.fetch ?? fetch;
  const minDelay = options.minDelayMs ?? 5_000;
  const maxDelay = options.maxDelayMs ?? 60_000;
  const controller = new AbortController();
  let stopped = false;
  let wake: (() => void) | undefined;

  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });

  const consume = async (body: ReadableStream<Uint8Array>) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = parseSseFrames(buffer);
        buffer = rest;
        for (const frame of frames) {
          if (frame.event !== "insert") continue;
          const event = parseInsertEvent(frame.data);
          if (!event) {
            options.log?.("ignored a malformed main-session insert event");
            continue;
          }
          try {
            await options.onInsert(event);
          } catch (error) {
            options.log?.(`main-session insert failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  };

  const done = (async () => {
    let delay = minDelay;
    while (!stopped) {
      try {
        const response = await doFetch(`${options.url}/stream`, {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (response.ok && response.body) {
          delay = minDelay;
          options.onConnect?.();
          await consume(response.body);
        } else {
          await response.body?.cancel().catch(() => {});
        }
      } catch {
        // Not running, or the stream broke: retry below.
      }
      if (stopped) break;
      await sleep(delay);
      delay = Math.min(maxDelay, delay * 2);
    }
  })();

  return {
    stop() {
      stopped = true;
      controller.abort();
      wake?.();
    },
    done,
  };
}

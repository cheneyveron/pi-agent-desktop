// Write-only memory: records go to memhana's records endpoint; when memhana is not reachable
// they land in memory-outbox.jsonl and are re-sent later. Nothing here ever reads memory.

import type { Store } from "./store.ts";

export interface MemoryRecord {
  t: string;
  speaker: "user" | "assistant";
  text: string;
  meta?: Record<string, unknown>;
}

export interface MemorySink {
  write(records: MemoryRecord[]): Promise<"sent" | "queued">;
  flushOutbox?(): Promise<number>;
}

const OUTBOX = "memory-outbox.jsonl";

/** memhana takes 'YYYY-MM-DD HH:MM'. */
function memhanaTime(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

export function createMemhanaSink(store: Store, options: {
  url?: string;
  bank?: string;
  fetchImpl?: typeof fetch;
} = {}): MemorySink {
  const url = (options.url ?? process.env.MEMHANA_URL ?? "http://127.0.0.1:9088").replace(/\/+$/, "");
  const bank = options.bank ?? process.env.MEMHANA_BANK ?? "work";
  const doFetch = options.fetchImpl ?? fetch;

  async function send(records: MemoryRecord[]): Promise<boolean> {
    if (process.env.MAIN_SESSION_MEMHANA === "off") return false;
    try {
      const res = await doFetch(`${url}/v1/banks/${encodeURIComponent(bank)}/records`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          records: records.map((r) => ({ t: memhanaTime(r.t), speaker: r.speaker, text: r.text, meta: { source: "pi-main-session", ...r.meta } })),
          flush: false,
          wait: false,
        }),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  return {
    async write(records) {
      if (records.length === 0) return "sent";
      if (await send(records)) return "sent";
      for (const record of records) store.appendLine(OUTBOX, record);
      return "queued";
    },
    async flushOutbox() {
      if (!store.dir) return 0;
      const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const path = join(store.dir, OUTBOX);
      if (!existsSync(path)) return 0;
      const records = readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as MemoryRecord]; } catch { return []; }
      });
      if (records.length === 0 || !(await send(records))) return 0;
      writeFileSync(path, "");
      return records.length;
    },
  };
}

/** Memory sink for tests and replay: keeps records in an array. */
export function createArraySink(): MemorySink & { records: MemoryRecord[] } {
  const records: MemoryRecord[] = [];
  return {
    records,
    async write(batch) {
      records.push(...batch);
      return "sent";
    },
  };
}

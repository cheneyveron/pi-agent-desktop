/**
 * The files the server and the updater sidecar (deploy/docker/updater.sh)
 * exchange through PI_WEB_UPDATER_DIR. Plain `key=value` lines: the sidecar is
 * a shell script without a JSON parser, and everything it reads is validated
 * again there.
 */

export interface UpdaterStatusFile {
  id: string;
  phase: string;
  version?: string;
  error?: string;
}

export function getUpdaterDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env.PI_WEB_UPDATER_DIR?.trim();
  return dir ? dir : null;
}

export function isStrictVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
}

export function formatUpdateRequest(id: string, version: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid request id.");
  if (!isStrictVersion(version)) throw new Error(`Invalid release version: ${version}`);
  return `id=${id}\nversion=${version}\n`;
}

export function parseUpdaterStatus(text: string): UpdaterStatusFile | null {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  const id = fields.get("id");
  const phase = fields.get("phase");
  if (!id || !phase) return null;
  return { id, phase, version: fields.get("version"), error: fields.get("error") || undefined };
}

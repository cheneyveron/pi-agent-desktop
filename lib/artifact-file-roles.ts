import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import type { FileOutputRole } from "./file-output-role.ts";

// The user's own corrections from the Artifacts page: a file moved into the
// outputs or out of them, by absolute path. Kept apart from settings.json so a
// long list of paths does not crowd the preferences other code rewrites.

const VERSION = 1;

export function getFileRolesPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web", "artifact-file-roles.json");
}

function isRole(value: unknown): value is FileOutputRole {
  return value === "output" || value === "process";
}

/** Every override; a missing or unreadable file means none. */
export function readFileRoleOverrides(rolesPath: string | null = getFileRolesPath()): Map<string, FileOutputRole> {
  const roles = new Map<string, FileOutputRole>();
  if (!rolesPath) return roles;
  try {
    const data = JSON.parse(readFileSync(rolesPath, "utf8")) as { roles?: unknown };
    if (data.roles && typeof data.roles === "object" && !Array.isArray(data.roles)) {
      for (const [path, role] of Object.entries(data.roles)) if (isRole(role)) roles.set(path, role);
    }
  } catch {
    // No corrections yet, or a file this version cannot read: the rules alone decide.
  }
  return roles;
}

/** Sets or (with null) clears one file's override. */
export function writeFileRoleOverride(path: string, role: FileOutputRole | null, rolesPath = getFileRolesPath()): void {
  const roles = readFileRoleOverrides(rolesPath);
  if (role) roles.set(path, role);
  else roles.delete(path);
  mkdirSync(dirname(rolesPath), { recursive: true });
  writePrivateFileAtomicSync(rolesPath, JSON.stringify({ version: VERSION, roles: Object.fromEntries(roles) }, null, 2));
}

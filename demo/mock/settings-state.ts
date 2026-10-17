import type { McpCodemodePreference } from "@/lib/api-types";

/** Mutable demo settings that the settings panels read and write. */
export const settings = {
  subagentsEnabled: true,
  subagentMaxConcurrent: 10,
  powerShellEnabled: false,
  artifactsEnabled: true,
  codemode: "automatic" as McpCodemodePreference,
  codemodeMode: "on" as "on" | "only",
  codemodeInlineBudget: undefined as number | undefined,
};

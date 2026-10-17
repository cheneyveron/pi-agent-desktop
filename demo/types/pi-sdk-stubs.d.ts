// The demo only ships Pi Web's browser code. A few copied modules keep
// type-only (or server-only) imports from the pi SDK; declare the
// names they use loosely so the demo typechecks without the agent runtime.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare module "@earendil-works/pi-coding-agent" {
  export type AgentSessionEvent = any;
  export type BashOperations = any;
  export type JsonAgentSessionEvent = any;
  export type ResourceDiagnostic = any;
  export type SessionManager = any;
  export const SessionManager: any;
  export type SettingsManager = any;
  export const SettingsManager: {
    fromStorage(
      storage: { withLock(scope: "global" | "project", fn: (text: string | undefined) => string | undefined | void): void },
      options?: { projectTrusted?: boolean },
    ): any;
    [key: string]: any;
  };
  export const CONFIG_DIR_NAME: string;
  // Settings › MCP edits mcp.json entries in the browser, so these keep their shape.
  export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";
  interface McpServerConfigBase {
    exposure?: McpExposure;
    description?: string;
    toolExposure?: Record<string, McpExposure>;
    enabled?: boolean;
    timeout?: number;
  }
  export interface McpStdioServerConfig extends McpServerConfigBase {
    type?: "stdio";
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
  }
  export interface McpHttpServerConfig extends McpServerConfigBase {
    type?: "http";
    url: string;
    headers?: Record<string, string>;
    oauth?: {
      clientId?: string;
      clientSecret?: string;
      callbackPort?: number;
      callbackUrl?: string;
      scope?: string;
      clientName?: string;
      clientRegistration?: "dcr" | "cimd";
      authServerMetadataUrl?: string;
    };
    auth?: { provider: string };
  }
  export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;
  export type SlashCommandInfo = any;
  export type Theme = any;
  export function getAgentDir(): string;
}
declare module "@earendil-works/pi-agent-core" {
  export type AgentMessage = any;
  export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}
declare module "@earendil-works/pi-ai" {
  export type ImageContent = any;
  export type TextContent = any;
}
// lib/global-settings-file.ts is server code that copied modules reach only
// through type imports; it never runs in the demo.
declare module "proper-lockfile" {
  const lockfile: any;
  export default lockfile;
}

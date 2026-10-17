/**
 * Settings › MCP (/api/mcp, /api/mcp/test, /api/mcp/sign-in). Three servers
 * in the global mcp.json, described the way GET /api/mcp describes them. The
 * switches, exposure, remove/undo, sign-out and Test work in memory; adding a
 * server or signing in needs a real server, so those explain the demo.
 */
import type { McpExposure } from "@earendil-works/pi-coding-agent";
import type {
  McpErrorResponse,
  McpResponse,
  McpScope,
  McpServerInfo,
  McpTestResponse,
  McpTestResult,
  McpTestTool,
} from "@/lib/api-types";
import type { MockRequest } from "./http";
import { delay, json } from "./http";
import { AGENT_DIR, PROJECT_ROOT } from "./paths";
import { settings } from "./settings-state";
import { demoOnlyMessage } from "./unavailable";

const GLOBAL_FILE = `${AGENT_DIR}/mcp.json`;
const SETTINGS_FILE = `${AGENT_DIR}/settings.json`;

type ServerDraft = Omit<McpServerInfo, "configKey" | "scope" | "sourcePath" | "validated" | "commandFields" | "variableReferences" | "masked" | "envNames" | "headerNames" | "usesOAuth"> &
  Partial<Pick<McpServerInfo, "envNames" | "headerNames" | "usesOAuth" | "variableReferences">>;

function server(draft: ServerDraft): McpServerInfo {
  return {
    scope: "global",
    sourcePath: GLOBAL_FILE,
    configKey: "",
    validated: true,
    envNames: [],
    headerNames: [],
    usesOAuth: false,
    commandFields: [],
    variableReferences: [],
    masked: false,
    ...draft,
  };
}

/** Tools a Test of each example server lists, in the server's order. */
const TOOLS: Record<string, Array<Omit<McpTestTool, "exposure">>> = {
  context7: [
    { name: "resolve-library-id", description: "Resolve a package name to a Context7 library id", readOnly: true },
    { name: "query-docs", description: "Fetch up-to-date documentation for a library", readOnly: true },
  ],
  filesystem: [
    { name: "read_text_file", description: "Read a file as text", readOnly: true },
    { name: "list_directory", description: "List the entries of a directory", readOnly: true },
    { name: "search_files", description: "Search for files matching a pattern", readOnly: true },
    { name: "write_file", description: "Create or overwrite a file", readOnly: false },
    { name: "edit_file", description: "Make line-based edits to a text file", readOnly: false },
  ],
  github: [
    { name: "search_issues", description: "Search issues and pull requests", readOnly: true },
    { name: "get_pull_request", description: "Get a pull request with its files and reviews", readOnly: true },
    { name: "create_issue", description: "Open a new issue", readOnly: false },
  ],
};

const INFO: Record<string, McpTestResult["serverInfo"]> = {
  context7: { name: "Context7", version: "2.1.0" },
  filesystem: { name: "secure-filesystem-server", version: "0.6.3" },
  github: { name: "github-mcp-server", version: "0.9.0" },
};

let servers: McpServerInfo[] = [
  server({
    name: "context7",
    enabled: true,
    transport: "http",
    exposure: "codemode",
    description: "Up-to-date documentation and code examples for libraries",
    url: "https://mcp.context7.com/mcp",
    headerNames: ["CONTEXT7_API_KEY"],
    variableReferences: [{ kind: "header", name: "CONTEXT7_API_KEY", variables: ["CONTEXT7_API_KEY"] }],
  }),
  server({
    name: "filesystem",
    enabled: true,
    transport: "stdio",
    exposure: "deferred",
    toolExposureCount: 2,
    description: "Read and edit files under ~/code",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/demo/code"],
  }),
  server({
    name: "github",
    enabled: false,
    transport: "http",
    exposure: "codemode",
    url: "https://api.githubcopilot.com/mcp/",
    usesOAuth: true,
    signedIn: true,
    oauthStateStored: true,
  }),
];

const removed = new Map<string, McpServerInfo>();

function configKey(entry: McpServerInfo): string {
  return `demo:${entry.name}:${entry.enabled}:${entry.exposure ?? "codemode"}`;
}

function testResult(entry: McpServerInfo): McpTestResult {
  const exposure: McpExposure = entry.exposure ?? "codemode";
  const tools = (TOOLS[entry.name] ?? []).map((tool) => ({
    ...tool,
    exposure: entry.name === "filesystem" && !tool.readOnly ? "hidden" as const : exposure,
  }));
  return {
    state: "connected",
    tools,
    toolCount: tools.length,
    serverInfo: INFO[entry.name],
    ...(entry.transport === "stdio" ? { cwd: PROJECT_ROOT } : {}),
    durationMs: entry.transport === "stdio" ? 1840 : 620,
    testedAt: Date.now(),
  };
}

// The filesystem server was tested once already, so its row shows a result.
const tested = new Map<string, McpTestResult>([["filesystem", { ...testResult(servers[1]), testedAt: Date.now() - 3 * 60 * 60_000 }]]);

function overview(cwd: string | null): McpResponse {
  const listed = servers.map((entry) => {
    const key = configKey(entry);
    const result = tested.get(entry.name);
    return { ...entry, configKey: key, ...(result ? { status: { origin: "test" as const, ...result } } : {}) };
  });
  const files: McpResponse["files"] = [{ scope: "global", path: GLOBAL_FILE, exists: true, problems: [] }];
  if (cwd) files.push({ scope: "project", path: `${cwd}/.pi/mcp.json`, exists: false, problems: [] });
  return {
    mcp: { available: true },
    codemode: {
      preference: settings.codemode,
      sandbox: { state: "available" },
      builtinDisabled: false,
      mode: { value: settings.codemodeMode, settingsPath: SETTINGS_FILE },
      inlineBudget: {
        ...(settings.codemodeInlineBudget !== undefined ? { value: settings.codemodeInlineBudget } : {}),
        settingsPath: SETTINGS_FILE,
        default: 3000,
        max: 1_000_000,
      },
    },
    files,
    servers: listed,
    ...(cwd ? {
      project: {
        cwd,
        trust: { requiresTrust: false, trusted: true, decision: null, inherited: false },
        trustFolder: { allowed: true as const },
      },
    } : {}),
  };
}

function refusal(status: number, reason: McpErrorResponse["reason"], message: string, extra: Partial<McpErrorResponse> = {}): Response {
  return json({ error: message, reason, ...extra } satisfies McpErrorResponse, status);
}

function find(scope: unknown, name: unknown): McpServerInfo | undefined {
  return scope === "global" ? servers.find((entry) => entry.name === name) : undefined;
}

export async function mcpRoute(request: MockRequest): Promise<Response> {
  const sub = request.segments[2];
  if (sub === "test") {
    const body = await request.json<{ scope?: McpScope; name?: string }>();
    const entry = find(body.scope, body.name);
    if (!entry) return refusal(404, "server-missing", "The file does not define this server", { name: body.name });
    await delay(entry.transport === "stdio" ? 1400 : 700, request.signal);
    const result = testResult(entry);
    tested.set(entry.name, result);
    return json({ scope: entry.scope, name: entry.name, configKey: configKey(entry), result } satisfies McpTestResponse);
  }
  if (sub === "sign-in") return refusal(501, "internal", demoOnlyMessage());

  if (request.method === "GET") return json(overview(request.query("cwd")));

  const body = await request.json<Record<string, unknown>>();
  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  switch (body.action) {
    case "enable":
    case "disable": {
      const entry = find(body.scope, body.name);
      if (!entry) return refusal(404, "server-missing", "The file does not define this server", { name: String(body.name) });
      entry.enabled = body.action === "enable";
      return json(overview(cwd));
    }
    case "set-enabled": {
      const list = Array.isArray(body.servers) ? body.servers as Array<{ scope: McpScope; name: string }> : [];
      const results = list.map((ref) => {
        const entry = find(ref.scope, ref.name);
        if (!entry) return { ...ref, error: "The file does not define this server", reason: "server-missing" as const };
        entry.enabled = Boolean(body.enabled);
        return ref;
      });
      return json({ ...overview(cwd), results });
    }
    case "set-exposure": {
      const entry = find(body.scope, body.name);
      if (!entry) return refusal(404, "server-missing", "The file does not define this server", { name: String(body.name) });
      entry.exposure = body.exposure as McpExposure;
      return json(overview(cwd));
    }
    case "remove": {
      const entry = find(body.scope, body.name);
      if (!entry) return refusal(404, "server-missing", "The file does not define this server", { name: String(body.name) });
      const token = `undo-${entry.name}-${Date.now()}`;
      removed.set(token, entry);
      servers = servers.filter((candidate) => candidate !== entry);
      return json({ ...overview(cwd), undo: { scope: entry.scope, name: entry.name, token, path: GLOBAL_FILE, expiresInMs: 60_000 } });
    }
    case "undo": {
      const entry = typeof body.token === "string" ? removed.get(body.token) : undefined;
      if (!entry) return refusal(410, "undo-unavailable", "The removal can no longer be undone");
      removed.delete(body.token as string);
      servers = [...servers, entry];
      return json({ ...overview(cwd), restored: { scope: entry.scope, name: entry.name } });
    }
    case "sign-out": {
      const entry = find(body.scope, body.name);
      if (!entry?.usesOAuth) return refusal(400, "sign-in-not-oauth", "This server does not sign in with OAuth", { name: String(body.name) });
      entry.signedIn = false;
      entry.oauthStateStored = false;
      return json({ ...overview(cwd), signedOut: { scope: entry.scope, name: entry.name, removed: true } });
    }
    case "add":
      return refusal(501, "internal", demoOnlyMessage());
    default:
      return refusal(400, "invalid-request", "Unknown action");
  }
}

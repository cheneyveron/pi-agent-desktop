// Pi SDK sessions for the main session's own turns (judgment turns and read-only dispatches).
// Same createAgentSessionFromServices path as lib/rpc-manager.ts, but outside the Next server's
// session registry, with no extensions, skills or context files, and an exact system prompt sent
// through lib/exact-system-prompt.ts (the one supported way to replace Pi's prompt).
//
// Models: only rdsec's claude-haiku-5-5 (default) or gpt-6-luna. MAIN_SESSION_MODEL may pick
// between the two; anything else refuses to start a turn.

import type { InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";

export const MODEL_PROVIDER = "rdsec";
export const ALLOWED_MODELS = ["claude-haiku-5-5", "gpt-6-luna"] as const;
export type AllowedModel = (typeof ALLOWED_MODELS)[number];
export const DEFAULT_MODEL: AllowedModel = "claude-haiku-5-5";

export function resolveModelId(requested: string | undefined = process.env.MAIN_SESSION_MODEL): AllowedModel {
  const id = (requested ?? DEFAULT_MODEL).trim().replace(/^rdsec\//, "");
  if (!(ALLOWED_MODELS as readonly string[]).includes(id)) {
    throw new Error(`model ${id} is not allowed for the main session; use one of ${ALLOWED_MODELS.join(", ")}`);
  }
  return id as AllowedModel;
}

export interface PiTurnOptions {
  cwd: string;
  systemPrompt: string;
  userText: string;
  modelId?: AllowedModel;
  /** Built-in tools to enable (dispatch: read-only set). Default none. */
  builtinTools?: string[];
  customTools?: ToolDefinition[];
  extensions?: InlineExtension[];
  /** Write the session to ~/.pi/agent/sessions so the user can open it. Default false. */
  persist?: boolean;
  timeoutMs?: number;
}

export interface PiTurnResult {
  text: string;
  sessionId: string;
}

export async function runPiTurn(options: PiTurnOptions): Promise<PiTurnResult> {
  const modelId = resolveModelId(options.modelId);
  const sdk = await import("@earendil-works/pi-coding-agent");
  const { createExactSystemPromptExtension } = await import("../lib/exact-system-prompt.ts");
  const agentDir = sdk.getAgentDir();
  const settingsManager = sdk.SettingsManager.create(options.cwd, agentDir);
  const services = await sdk.createAgentSessionServices({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [createExactSystemPromptExtension(() => options.systemPrompt), ...(options.extensions ?? [])],
    },
  });
  const model = services.modelRuntime.getModel(MODEL_PROVIDER, modelId);
  if (!model) throw new Error(`${MODEL_PROVIDER}/${modelId} is not configured in models.json`);
  const sessionManager = options.persist ? sdk.SessionManager.create(options.cwd) : sdk.SessionManager.inMemory(options.cwd);
  const customTools = options.customTools ?? [];
  const toolNames = [...(options.builtinTools ?? []), ...customTools.map((t) => t.name)];
  const { session } = await sdk.createAgentSessionFromServices({
    services,
    sessionManager,
    model,
    thinkingLevel: "off",
    tools: toolNames,
    customTools,
  });
  session.setActiveToolsByName(toolNames);
  const timer = setTimeout(() => { void session.abort(); }, options.timeoutMs ?? 120_000);
  try {
    await session.prompt(options.userText);
    return { text: session.getLastAssistantText() ?? "", sessionId: session.sessionId };
  } finally {
    clearTimeout(timer);
    session.dispose();
  }
}

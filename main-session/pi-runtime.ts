// Pi SDK sessions for the main session's own turns (judgment turns and read-only dispatches).
// Same createAgentSessionFromServices path as lib/rpc-manager.ts, but outside the Next server's
// session registry, with no extensions, skills or context files, and an exact system prompt sent
// through lib/exact-system-prompt.ts (the one supported way to replace Pi's prompt).
//
// Model: whatever the user chose (POST /model, saved in settings.json) or MAIN_SESSION_MODEL,
// as `provider/modelId`, resolved through the Pi model registry on every turn. There is no
// built-in default: without a choice the service runs no model turns at all.

import type { InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MAIN_THINKING_LEVELS, type MainThinkingLevel, type ModelRef } from "./types.ts";

export class ModelChoiceError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ModelChoiceError";
    this.status = status;
  }
}

/** `provider/modelId` → ref. The model id may itself contain slashes (OpenRouter ids). Empty → null. */
export function parseModelRef(value: unknown): ModelRef | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ModelChoiceError("model must be a \"provider/modelId\" string or null");
  const text = value.trim();
  if (!text) return null;
  const slash = text.indexOf("/");
  const provider = slash > 0 ? text.slice(0, slash).trim() : "";
  const modelId = slash > 0 ? text.slice(slash + 1).trim() : "";
  if (!provider || !modelId) throw new ModelChoiceError(`model "${text}" must be written as provider/modelId`);
  return { provider, modelId };
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.modelId}`;
}

/** A reasoning level for the main session's turns; "off" (the default) when unset or empty. */
export function parseThinkingLevel(value: unknown): MainThinkingLevel {
  if (value === null || value === undefined || value === "") return "off";
  if (typeof value !== "string" || !(MAIN_THINKING_LEVELS as readonly string[]).includes(value)) {
    throw new ModelChoiceError(`thinkingLevel must be one of ${MAIN_THINKING_LEVELS.join(", ")}`);
  }
  return value as MainThinkingLevel;
}

/** MAIN_SESSION_MODEL, when set, overrides the saved choice. A malformed value throws. */
export function envModelRef(value: string | undefined = process.env.MAIN_SESSION_MODEL): ModelRef | null {
  try {
    return parseModelRef(value);
  } catch (error) {
    throw new Error(`MAIN_SESSION_MODEL: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The part of Pi's ModelRuntime the lookups need. */
export interface ModelLookup<M = unknown> {
  getModel(provider: string, modelId: string): M | undefined;
}

/** The registry's model for a ref, or an error that says what to do about it. */
export function lookupModel<M>(runtime: ModelLookup<M>, ref: ModelRef): M {
  const model = runtime.getModel(ref.provider, ref.modelId);
  if (!model) {
    throw new ModelChoiceError(`${formatModelRef(ref)} is not configured in Pi any more (no such provider/model in the catalog or models.json); choose another model for the main session`);
  }
  return model;
}

/** The part of Pi's ModelRuntime the save-time check needs. */
export interface AvailabilityLookup extends ModelLookup {
  getAvailable(provider?: string): Promise<readonly { provider: string; id: string }[]>;
}

/**
 * Save-time check: the model exists in the registry and its provider has a credential, i.e.
 * it is one the app's own model lists offer. Turns re-resolve it, so a later sign-out or
 * models.json edit is reported by the turn, not silently ignored.
 */
export async function checkModelAvailable(runtime: AvailabilityLookup, ref: ModelRef): Promise<void> {
  lookupModel(runtime, ref);
  const available = await runtime.getAvailable(ref.provider);
  if (!available.some((model) => model.provider === ref.provider && model.id === ref.modelId)) {
    throw new ModelChoiceError(`${formatModelRef(ref)} cannot be used: provider ${ref.provider} is not signed in or has no key`);
  }
}

/** Production save-time check against the user's Pi registry (offline: no catalog fetch). */
export async function checkConfiguredModel(ref: ModelRef): Promise<void> {
  const sdk = await import("@earendil-works/pi-coding-agent");
  const { join } = await import("node:path");
  const agentDir = sdk.getAgentDir();
  const runtime = await sdk.ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  await checkModelAvailable(runtime, ref);
}

export interface PiTurnOptions {
  cwd: string;
  systemPrompt: string;
  userText: string;
  model: ModelRef;
  /** Built-in tools to enable (dispatch: read-only set). Default none. */
  builtinTools?: string[];
  customTools?: ToolDefinition[];
  extensions?: InlineExtension[];
  /** Write the session to ~/.pi/agent/sessions so the user can open it. Default false. */
  persist?: boolean;
  timeoutMs?: number;
  /** Reasoning level of the turn. Default "off". */
  thinkingLevel?: MainThinkingLevel;
  /** Each assistant text delta as it streams, for live display. */
  onText?: (delta: string) => void;
}

export interface PiTurnResult {
  text: string;
  sessionId: string;
}

export async function runPiTurn(options: PiTurnOptions): Promise<PiTurnResult> {
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
  const model = lookupModel(services.modelRuntime, options.model);
  const sessionManager = options.persist ? sdk.SessionManager.create(options.cwd) : sdk.SessionManager.inMemory(options.cwd);
  const customTools = options.customTools ?? [];
  const toolNames = [...(options.builtinTools ?? []), ...customTools.map((t) => t.name)];
  const { session } = await sdk.createAgentSessionFromServices({
    services,
    sessionManager,
    model,
    thinkingLevel: options.thinkingLevel ?? "off",
    tools: toolNames,
    customTools,
  });
  session.setActiveToolsByName(toolNames);
  const onText = options.onText;
  const unsubscribe = onText
    ? session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") onText(event.assistantMessageEvent.delta);
    })
    : undefined;
  const timer = setTimeout(() => { void session.abort(); }, options.timeoutMs ?? 120_000);
  try {
    await session.prompt(options.userText);
    return { text: session.getLastAssistantText() ?? "", sessionId: session.sessionId };
  } finally {
    clearTimeout(timer);
    unsubscribe?.();
    session.dispose();
  }
}

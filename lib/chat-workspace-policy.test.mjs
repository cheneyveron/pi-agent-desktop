import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [newRoute, sessionsRoute, validateRoute, rpcManager, sessionReader] = await Promise.all([
  readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/sessions/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/cwd/validate/route.ts", import.meta.url), "utf8"),
  readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8"),
  readFile(new URL("./session-reader.ts", import.meta.url), "utf8"),
]);

test("new chats force an empty tool allow-list regardless of the request", () => {
  assert.match(newRoute, /const chatWorkspace = typeof cwd === "string" && isChatWorkspacePath\(cwd\)/);
  assert.match(newRoute, /const toolNames = chatWorkspace \? \[\] : requestedToolNames/);
  assert.match(newRoute, /if \(chatWorkspace\) await ensureChatWorkspace\(\)/);
});

test("persisted chat sessions also force no tools and no context files", () => {
  const startup = rpcManager.slice(rpcManager.indexOf("export async function startRpcSession"));

  assert.match(startup, /const chatWorkspace = isChatWorkspacePath\(sessionCwd\)/);
  assert.match(startup, /const subagentResources = sessionFile && !chatWorkspace/);
  assert.match(startup, /const selectedToolNames = chatWorkspace\s*\?\s*\[\]\s*:\s*subagentResources\?\.tools \?\? persistedToolNames \?\? requestedToolNames/);
  assert.match(startup, /chatWorkspace \? \{ noContextFiles: true \} : \{\}/);
  assert.match(startup, /chatWorkspace\s*\?\s*\(\) => ""/);
  assert.match(startup, /chatWorkspace,\s*onAgentRunComplete/);
});

test("chat runtimes reject shell and tool mutations", () => {
  const setTools = rpcManager.slice(
    rpcManager.indexOf('case "set_tools"'),
    rpcManager.indexOf('case "reload"'),
  );
  const bash = rpcManager.slice(
    rpcManager.indexOf('case "bash"'),
    rpcManager.indexOf('case "abort_bash"'),
  );
  const setter = rpcManager.slice(
    rpcManager.indexOf("export async function setRpcSessionTools"),
    rpcManager.indexOf("export function getRunningRpcSessionIds"),
  );

  assert.match(setTools, /if \(this\.chatWorkspace\) \{\s*throw new Error\("Chats have no tools\. Open a project to change the tool preset\."\)/);
  assert.match(bash, /if \(this\.chatWorkspace\) \{\s*throw new Error\("Shell commands are unavailable in chats\. Open a project to run one\."\)/);
  assert.match(setter, /if \(isChatWorkspacePath\(manager\.getCwd\(\)\)\) \{\s*throw new Error\("Chats have no tools/);
  assert.match(setter, /if \(existing\.isChatWorkspace\(\)\) \{\s*throw new Error\("Chats have no tools/);
});

test("chat runtimes report no tools or slash commands", () => {
  const getTools = rpcManager.slice(
    rpcManager.indexOf('case "get_tools"'),
    rpcManager.indexOf('case "get_commands"'),
  );
  const getCommands = rpcManager.slice(
    rpcManager.indexOf('case "get_commands"'),
    rpcManager.indexOf('case "set_tools"'),
  );

  assert.match(getTools, /if \(this\.chatWorkspace\) return \[\];/);
  assert.match(getCommands, /if \(this\.chatWorkspace\) return \{ commands: \[\] \};/);
});

test("server session classification strips every project field from chats", () => {
  assert.match(
    sessionReader,
    /if \(isChatWorkspacePath\(session\.cwd\)\) \{\s*return \{\s*\.\.\.session,\s*workspaceKind: "chat" as const,\s*projectRoot: undefined,\s*projectKey: undefined,\s*branch: undefined,\s*isWorktree: undefined,/,
  );
  assert.match(
    sessionReader,
    /await Promise\.all\(uniqueCwds\.map\(async \(cwd\) => \{\s*if \(isChatWorkspacePath\(cwd\)\) return;/,
  );
});

test("chat workspace cwd is server-owned and allow-listed", () => {
  assert.match(sessionsRoute, /ensureChatWorkspace\(\)/);
  assert.match(sessionsRoute, /allowFileRoot\(chatWorkspaceCwd\)/);
  assert.match(sessionsRoute, /chatWorkspaceCwd,/);
  assert.match(validateRoute, /if \(isChatWorkspacePath\(normalizedCwd\)\) \{[\s\S]*?workspaceKind: "chat"/);
});

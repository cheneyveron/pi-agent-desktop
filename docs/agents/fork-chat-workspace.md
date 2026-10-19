# Non-project chats — fork notes

Chats are a first-class sidebar section beside Projects, but not a second
session system. They reuse the existing `SessionInfo`, JSONL, SSE, fork, search,
running-state, and persistence paths. The only new backing concept is a hidden
cwd that Pi requires for every session.

## Workspace identity

- `lib/chat-workspace.ts` owns `~/.pi/agent/chat-workspace` (derived from
  `getAgentDir()`), lazy directory creation, and exact-path recognition through
  `samePath()`.
- `GET /api/chat-workspace` creates and returns that cwd. `GET /api/sessions`
  also returns it as `chatWorkspaceCwd`, so the sidebar and shell can share one
  server-owned answer.
- `attachSessionProjectInfo()` in `lib/session-reader.ts` sets
  `workspaceKind: "chat"` and removes `projectRoot`, `projectKey`, `branch`, and
  `isWorktree`. Project sessions receive `workspaceKind: "project"`.
- `POST /api/cwd/validate` recognizes the hidden cwd and returns the same
  server identity instead of treating it as a project.

The browser must never construct or compare the hidden path by string
derivation. It uses `workspaceKind`, the `/api/chat-workspace` answer, or the
`chatWorkspaceCwd` returned by `/api/sessions`.

## UI boundaries

- `components/SessionSidebar.tsx` renders Chats above Projects, five session
  families at a time with "Show more", and keeps the section available when
  there are no projects.
- Chats never enter `groupByProject()`, recent projects, project pickers,
  worktree lookup, project trust, the file tree, the right workspace panel,
  terminals, or Scheduled's project roots.
- `AppShell` closes and suppresses project-only chrome while a chat is active.
  The window title and topbar subtitle never expose the hidden cwd.
- `ChatInput` disables `@` file completions and hides `#` session mentions,
  `!` shell mode, and non-image attachments. Images remain available as model
  input.

## Server-enforced policy

Client checks are affordances only; the server enforces the model-only policy.

- `POST /api/agent/new` forces `toolNames: []` whenever the cwd is the hidden
  chat workspace.
- `startRpcSession()` re-detects the workspace from the session file, so old
  chats also start with no tools even if their transcript contains a stale tool
  selection. It never reads subagent resources for a chat.
- Chat sessions load no extensions, skills, prompt templates, themes, context
  files, MCP servers, or built-in tools. Their exact system prompt is empty.
- `get_tools` returns `[]`, `get_commands` returns no commands, and `set_tools`
  and `bash` are rejected with a message pointing the user to a project.

`chatOnly` and `chatWorkspace` are different flags. `chatOnly` means a project
session with an empty tool allow-list; `chatWorkspace` means the hidden
non-project workspace and additionally disables context files and shell.

## Tests

- `lib/chat-workspace.test.mjs` covers path ownership and private directory
  creation.
- `lib/chat-workspace-policy.test.mjs` pins the server-side tool, shell,
  context-file, session-classification, and allow-list guards.
- `components/AppShell.chat-workspace.test.mjs` pins server-provided
  classification and project-workbench suppression.
- `components/SessionSidebar.test.mjs` and the session-search tests pin the
  Chats section, project separation, pagination, and path-safe search labels.

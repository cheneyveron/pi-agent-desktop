import { NextResponse } from "next/server";
import { readdirSync, statSync, type Stats } from "fs";
import { userHome } from "@/lib/user-home";
import { isAbsolute, resolve } from "path";
import { allowFileRoot } from "@/lib/file-access";
import { directoryPermissionMessage, isPermissionError } from "@/lib/directory-browser";
import { projectIdentityKey } from "@/lib/project-identity";
import { resolveProject } from "@/lib/worktree";
import { ensureChatCwd, ensureChatWorkspace, isChatRootPath, isChatWorkspacePath } from "@/lib/chat-workspace";

function normalizeCwd(cwd: string): string {
  if (cwd === "~") return userHome();
  if (cwd.startsWith("~/")) return resolve(userHome(), cwd.slice(2));
  return isAbsolute(cwd) ? cwd : resolve(cwd);
}

// POST /api/cwd/validate  body: { cwd: string }
// Validates a candidate workspace before the UI selects it.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";

    if (!cwd) {
      return NextResponse.json({ error: "Path is required" }, { status: 400 });
    }

    const normalizedCwd = normalizeCwd(cwd);
    if (isChatWorkspacePath(normalizedCwd)) {
      const chatRoot = await ensureChatWorkspace();
      // A chat's own folder (or the legacy shared cwd) stays what it is; only the root is "new chat".
      const chatCwd = isChatRootPath(normalizedCwd) ? chatRoot : normalizedCwd;
      await ensureChatCwd(chatCwd);
      allowFileRoot(chatCwd);
      return NextResponse.json({
        success: true,
        cwd: chatCwd,
        projectRoot: null,
        projectKey: null,
        workspaceKind: "chat",
      });
    }
    let stat: Stats;
    try {
      stat = statSync(normalizedCwd);
    } catch (error) {
      // macOS TCC denies stat of protected folders (Desktop/Documents/Downloads)
      // with EPERM — that is a permission problem, not a missing path.
      if (isPermissionError(error)) {
        return NextResponse.json({ error: directoryPermissionMessage(cwd) }, { status: 403 });
      }
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    if (!stat.isDirectory()) {
      return NextResponse.json({ error: `Path is not a directory: ${cwd}` }, { status: 400 });
    }

    // Probe read access so a permission-denied folder is rejected at selection
    // time instead of failing later (file tree, git status, session reads).
    // accessSync only checks mode bits — it does not exercise macOS TCC, so
    // the probe must actually readdir.
    try {
      readdirSync(normalizedCwd);
    } catch (error) {
      if (isPermissionError(error)) {
        return NextResponse.json({ error: directoryPermissionMessage(cwd) }, { status: 403 });
      }
      return NextResponse.json({ error: `Directory cannot be read: ${cwd}` }, { status: 400 });
    }

    allowFileRoot(normalizedCwd);
    const project = await resolveProject(normalizedCwd);
    return NextResponse.json({
      success: true,
      cwd: normalizedCwd,
      projectRoot: project.projectRoot,
      projectKey: projectIdentityKey(project.projectRoot),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

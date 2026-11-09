import { isAbsolute } from "node:path";
import { NextResponse } from "next/server";
import { getFileOutput, getWrittenContent } from "@/lib/artifact-index";
import { writeFileRoleOverride } from "@/lib/artifact-file-roles";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { listAllSessions } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

// GET ?path= — every recorded write/edit of one file the model touched.
// GET ?session=&toolCallId= — what that `write` call put in the file, read
// from the transcript, for a file that is gone from disk.
// PUT { path, role: "output" | "process" | null } — the user's own choice of
// whether a listed file is an output; null goes back to the rules.
// Neither reads the file itself: its contents go through /api/files and its
// allow-list, with the session as the reference that authorizes the path.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const headers = { "Cache-Control": "no-store" };
  const toolCallId = params.get("toolCallId");
  try {
    const sessions = await listAllSessions({ allowStale: true });
    if (toolCallId) {
      const session = sessions.find((item) => item.id === params.get("session"));
      const written = session && session.relation?.kind !== "subagent" ? await getWrittenContent(session, toolCallId) : null;
      if (!written) return NextResponse.json({ error: "Write not found" }, { status: 404, headers });
      return NextResponse.json(written, { headers });
    }
    const path = params.get("path") ?? "";
    if (!path || path.length > 4096) {
      return NextResponse.json({ error: "path is required" }, { status: 400, headers });
    }
    const detail = await getFileOutput(sessions, path);
    if (!detail) return NextResponse.json({ error: "File not found" }, { status: 404, headers });
    return NextResponse.json(detail, { headers });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500, headers });
  }
}

export async function PUT(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415, headers });
  }
  try {
    const body = await request.json() as { path?: unknown; role?: unknown };
    const { path, role } = body ?? {};
    if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096) {
      return NextResponse.json({ error: "path must be an absolute path" }, { status: 400, headers });
    }
    if (role !== "output" && role !== "process" && role !== null) {
      return NextResponse.json({ error: "role must be \"output\", \"process\" or null" }, { status: 400, headers });
    }
    // Only files the page lists can be moved, so the file stays a list of real rows.
    const sessions = await listAllSessions({ allowStale: true });
    if (!await getFileOutput(sessions, path)) {
      return NextResponse.json({ error: "File not found" }, { status: 404, headers });
    }
    writeFileRoleOverride(path, role);
    return NextResponse.json(await getFileOutput(sessions, path), { headers });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500, headers });
  }
}

import { NextResponse } from "next/server";
import { getFileOutput, getWrittenContent } from "@/lib/artifact-index";
import { listAllSessions } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

// GET ?path= — every recorded write/edit of one file the model touched.
// GET ?session=&toolCallId= — what that `write` call put in the file, read
// from the transcript, for a file that is gone from disk.
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

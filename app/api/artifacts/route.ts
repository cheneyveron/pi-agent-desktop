import { NextResponse } from "next/server";
import { listArtifacts } from "@/lib/artifact-index";
import { listAllSessions } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

// GET ?q= — artifacts across every session, newest first. Type and project
// filters run in the page over this list.
export async function GET(request: Request) {
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  const headers = { "Cache-Control": "no-store" };
  if (q.length > 200) {
    return NextResponse.json({ error: "Search query exceeds 200 characters" }, { status: 400, headers });
  }
  try {
    // Same catalogue and staleness trade-off as /api/sessions/search: paths
    // never come from the request, and a rebuild is not worth blocking on.
    const sessions = await listAllSessions({ allowStale: true });
    return NextResponse.json(await listArtifacts(sessions, q, request.signal), { headers });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500, headers });
  }
}

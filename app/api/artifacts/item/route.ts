import { NextResponse } from "next/server";
import { getArtifact } from "@/lib/artifact-index";
import { listAllSessions } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

// GET ?session=&identifier=[&latest=1] — one artifact with every version's
// content, or only the newest (list thumbnails).
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const sessionId = params.get("session") ?? "";
  const identifier = params.get("identifier") ?? "";
  const latestOnly = params.get("latest") === "1";
  const headers = { "Cache-Control": "no-store" };
  if (!sessionId || !identifier) {
    return NextResponse.json({ error: "session and identifier are required" }, { status: 400, headers });
  }
  try {
    let session = (await listAllSessions({ allowStale: true })).find((item) => item.id === sessionId);
    // A session written since the stale catalogue was built.
    if (!session) session = (await listAllSessions()).find((item) => item.id === sessionId);
    const artifact = session && session.relation?.kind !== "subagent" ? await getArtifact(session, identifier) : null;
    if (!artifact) {
      return NextResponse.json({ error: "Artifact not found" }, { status: 404, headers });
    }
    const versions = latestOnly ? artifact.versions.slice(-1) : artifact.versions;
    return NextResponse.json({
      identifier: artifact.identifier,
      versions: versions.map((version) => ({
        entryId: version.entryId,
        timestamp: version.timestamp,
        title: version.title,
        type: version.type,
        lang: version.lang,
        content: version.content,
        complete: version.complete,
        onActiveBranch: version.onActiveBranch,
      })),
    }, { headers });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500, headers });
  }
}

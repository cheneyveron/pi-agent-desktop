import { isAbsolute } from "node:path";
import { NextResponse } from "next/server";
import { writeFavorite, type FavoriteTarget } from "@/lib/artifact-favorites";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const MAX_FIELD_LENGTH = 4096;

function isField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

function parseTarget(body: Record<string, unknown>): FavoriteTarget | null {
  if (body.kind === "file" && isField(body.path) && isAbsolute(body.path)) return { kind: "file", path: body.path };
  if (body.kind === "artifact" && isField(body.sessionId) && isField(body.identifier)) {
    return { kind: "artifact", sessionId: body.sessionId, identifier: body.identifier };
  }
  return null;
}

// PUT { kind: "file", path, favorite } | { kind: "artifact", sessionId, identifier, favorite }
// stars or unstars one row of the Artifacts page.
export async function PUT(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415, headers });
  }
  try {
    const body = await request.json() as Record<string, unknown> | null;
    const target = body && typeof body === "object" ? parseTarget(body) : null;
    if (!target || typeof body?.favorite !== "boolean") {
      return NextResponse.json({ error: "Expected a file path or artifact id and a boolean favorite" }, { status: 400, headers });
    }
    writeFavorite(target, body.favorite);
    return NextResponse.json({ favorite: body.favorite }, { headers });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500, headers });
  }
}

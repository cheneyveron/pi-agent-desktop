import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isArtifactsPromptEnabled, writeArtifactsPromptEnabled } from "@/lib/artifact-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ enabled: isArtifactsPromptEnabled() });
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as { enabled?: unknown };
    if (typeof body?.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    return NextResponse.json({ enabled: writeArtifactsPromptEnabled(body.enabled) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import { getPiWebSettingsPath, updatePiWebSettings } from "@/lib/artifact-settings";
import { parseMainSessionSettingsPatch, readMainSessionSettings } from "@/lib/main-session-settings";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// Settings › Main session. Not under /api/main-session/, which proxies to the service: these
// settings must stay readable and writable while the service is down or dormant.

export async function GET() {
  return NextResponse.json(readMainSessionSettings(getPiWebSettingsPath()));
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let patch;
  try {
    patch = parseMainSessionSettingsPatch(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
  try {
    const path = getPiWebSettingsPath();
    updatePiWebSettings({ mainSession: { ...readMainSessionSettings(path), ...patch } }, path);
    return NextResponse.json(readMainSessionSettings(path));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

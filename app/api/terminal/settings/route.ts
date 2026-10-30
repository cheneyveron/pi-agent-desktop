import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getTerminalSettings, writeTerminalShellPreference } from "@/lib/terminal-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(getTerminalSettings());
  } catch {
    return NextResponse.json({ error: "Could not read terminal settings" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Expected application/json" }, { status: 415 });
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const shell = body && typeof body === "object" && !Array.isArray(body) && "shell" in body ? body.shell : undefined;
  if (typeof shell !== "string" || !shell) return NextResponse.json({ error: "Invalid terminal" }, { status: 400 });
  try {
    const settings = getTerminalSettings();
    if (shell !== "auto" && !settings.options.some(option => option.value === shell)) {
      return NextResponse.json({ error: "Terminal is unavailable" }, { status: 400 });
    }
    writeTerminalShellPreference(shell);
    return NextResponse.json(getTerminalSettings());
  } catch {
    return NextResponse.json({ error: "Could not save terminal settings" }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { ensureChatWorkspace } from "@/lib/chat-workspace";
import { allowFileRoot } from "@/lib/file-access";

export const dynamic = "force-dynamic";

/** The hidden cwd used by non-project chats, created on demand. */
export async function GET() {
  try {
    const cwd = await ensureChatWorkspace();
    allowFileRoot(cwd);
    return NextResponse.json(
      { cwd },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

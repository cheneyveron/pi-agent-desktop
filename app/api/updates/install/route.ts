import {
  ServerUpdateError,
  getServerUpdateState,
  startServerUpdate,
} from "@/lib/server-updater";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/** Progress of the server's own update (supported only with an updater sidecar). */
export async function GET() {
  return Response.json(await getServerUpdateState(), { headers: NO_STORE });
}

/**
 * Ask the updater sidecar to pull the latest image and recreate this server.
 * The target is never taken from the request: it is always the newest stable
 * release of the fixed repository. Host/origin checks and the web password run in proxy.ts.
 */
export async function POST() {
  try {
    return Response.json(await startServerUpdate(), { status: 202, headers: NO_STORE });
  } catch (error) {
    const status = error instanceof ServerUpdateError && error.code === "unsupported" ? 409 : 500;
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status, headers: NO_STORE },
    );
  }
}

import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// /api/main-session/* — forwards the request unchanged to the main-session service on
// 127.0.0.1:30180 (MAIN_SESSION_PORT), streaming the response back so GET /stream (SSE) works.
// No business logic lives here: the service is a separate process (main-session/server.mjs).
// When it is not running the UI gets 503 {error, running:false} and shows "主会话未运行".

const PORT = Number(process.env.MAIN_SESSION_PORT ?? 30180);
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control"];

type Context = { params: Promise<{ path: string[] }> };

async function forward(req: Request, { params }: Context): Promise<Response> {
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    // Same guard as the other write routes: a cross-site page cannot drive the service.
    if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
    if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const { path } = await params;
  const search = new URL(req.url).search;
  const target = `http://127.0.0.1:${PORT}/${path.map(encodeURIComponent).join("/")}${search}`;
  const headers: Record<string, string> = {};
  const contentType = req.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;
  const accept = req.headers.get("accept");
  if (accept) headers.accept = accept;
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body: await req.arrayBuffer() }),
      signal: req.signal,
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    return NextResponse.json({ error: "main session is not running", running: false }, { status: 503 });
  }
  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  if (upstream.headers.get("content-type")?.startsWith("text/event-stream")) {
    responseHeaders.set("x-accel-buffering", "no");
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export const GET = forward;
export const POST = forward;

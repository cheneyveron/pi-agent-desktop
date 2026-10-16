import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "../request-security";
import { toTaskView } from "./task-view";
import { isValidationError } from "./types";

export { toTaskView };

/** Shared guard for routes that change anything. Returns a response to send, or null to go on. */
export function rejectUnsafeWrite(req: Request, options: { json?: boolean } = {}): NextResponse | null {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (options.json !== false && !hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  return null;
}

export function errorResponse(error: unknown): NextResponse {
  if (isValidationError(error)) {
    return NextResponse.json({
      error: error.message,
      code: "validation",
      ...(error.key ? { key: error.key, ...(error.params ? { params: error.params } : {}) } : {}),
    }, { status: 400 });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}

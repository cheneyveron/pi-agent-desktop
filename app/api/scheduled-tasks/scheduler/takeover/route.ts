import { NextResponse } from "next/server";
import { errorResponse, rejectUnsafeWrite } from "@/lib/scheduled-tasks/api";
import { getScheduler, isSchedulerTakeoverError } from "@/lib/scheduled-tasks";

export const dynamic = "force-dynamic";

// POST /api/scheduled-tasks/scheduler/takeover - acquire the lease if it is
// stale or its owner has exited. A fresh, live owner is never overridden: two
// owners could otherwise fire the same task independently.
export async function POST(req: Request) {
  const rejected = rejectUnsafeWrite(req, { json: false });
  if (rejected) return rejected;
  try {
    const owner = await getScheduler().takeover();
    return NextResponse.json({ owner });
  } catch (error) {
    if (isSchedulerTakeoverError(error)) {
      return NextResponse.json(
        { error: error.message, code: "owner_live", ownerInfo: error.info },
        { status: 409 },
      );
    }
    return errorResponse(error);
  }
}

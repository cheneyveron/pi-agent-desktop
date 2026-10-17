"use client";

// Fork-owned: probes whether the session's workspace folder still exists, so the
// composer can say so instead of reporting a model error. AppShell (upstream-owned)
// only calls this.

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { UnavailableWorkspace, WorkspaceAvailability } from "@/lib/workspace-availability";

export function useWorkspaceAvailability(
  cwd: string | null,
  setModelsRefreshKey: Dispatch<SetStateAction<number>>,
) {
  // "unknown": the probe itself failed, so nothing is blocked on its account.
  const [workspaceStatus, setWorkspaceStatus] = useState<{ cwd: string; availability: WorkspaceAvailability | "unknown" } | null>(null);
  const workspaceStatusRef = useRef(workspaceStatus);
  const [workspaceStatusCheck, setWorkspaceStatusCheck] = useState(0);

  // A workspace deleted outside the app keeps its history, but every cwd-scoped
  // request then fails and the composer reported it as a model error (#1061).
  // Probe the folder itself so the chat can say what happened and hold new runs.
  useEffect(() => {
    if (!cwd) return;
    const probedCwd = cwd;
    const controller = new AbortController();
    fetch(`/api/cwd/status?cwd=${encodeURIComponent(probedCwd)}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { availability?: WorkspaceAvailability };
        return response.ok && data.availability ? data.availability : "unknown" as const;
      })
      .catch((error) => (error instanceof DOMException && error.name === "AbortError" ? null : "unknown" as const))
      .then((availability) => {
        if (!availability || controller.signal.aborted) return;
        const previous = workspaceStatusRef.current;
        const recovered = availability === "available"
          && previous?.cwd === probedCwd
          && previous.availability !== "available"
          && previous.availability !== "unknown";
        workspaceStatusRef.current = { cwd: probedCwd, availability };
        setWorkspaceStatus({ cwd: probedCwd, availability });
        // The model list loaded while the folder was gone only holds its error.
        if (recovered) setModelsRefreshKey((key) => key + 1);
      });
    return () => controller.abort();
  }, [cwd, workspaceStatusCheck, setModelsRefreshKey]);

  const workspaceAvailability = cwd && workspaceStatus?.cwd === cwd
    ? workspaceStatus.availability
    : null;
  const unavailableWorkspace = useMemo<UnavailableWorkspace | null>(() => (
    cwd && workspaceAvailability && workspaceAvailability !== "available" && workspaceAvailability !== "unknown"
      ? { cwd, availability: workspaceAvailability }
      : null
  ), [cwd, workspaceAvailability]);
  const recheckWorkspace = useCallback(() => setWorkspaceStatusCheck((check) => check + 1), []);

  return { workspaceAvailability, unavailableWorkspace, recheckWorkspace };
}

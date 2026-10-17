"use client";

// Fork-owned: state and actions behind the worktree pages of the project "…"
// menu (components/ProjectContextMenu.tsx) — fetch remote branches, create and
// remove worktrees. SessionSidebar (upstream-owned) supplies what happens to
// the sidebar afterwards through the callbacks.

import { useCallback, useState } from "react";
import {
  createProjectWorktree,
  fetchRemoteBranches,
  removeProjectWorktree,
  type WorktreeRemoval,
} from "@/components/ProjectContextMenu";

interface ProjectWorktreeCallbacks {
  /** A fetch landed; merge the fresh branch lists into the menu. */
  onBranchesFetched: (projectRoot: string, lists: { branches: string[]; remoteBranches: string[] }) => void;
  /** A worktree was created at `path`; select it and refresh. */
  onWorktreeCreated: (projectRoot: string, path: string, branch: string) => void;
  /** A worktree checkout was removed; leave it if it was selected and refresh. */
  onWorktreeRemoved: (projectRoot: string, path: string) => void;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useProjectWorktreeActions({ onBranchesFetched, onWorktreeCreated, onWorktreeRemoved }: ProjectWorktreeCallbacks) {
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<WorktreeRemoval | null>(null);
  const [newBranch, setNewBranchValue] = useState("");

  /** Clears everything a closed or re-opened menu must not carry over. */
  const reset = useCallback(() => {
    setError(null);
    setConfirmRemove(null);
    setNewBranchValue("");
  }, []);

  const setNewBranch = useCallback((value: string) => {
    setNewBranchValue(value);
    setError(null);
  }, []);

  const requestRemove = useCallback((path: string) => {
    setError(null);
    setConfirmRemove({ path, force: false });
  }, []);

  const cancelRemove = useCallback(() => setConfirmRemove(null), []);

  const fetchBranches = useCallback(async (projectRoot: string) => {
    if (fetching) return;
    setFetching(true);
    setError(null);
    try {
      onBranchesFetched(projectRoot, await fetchRemoteBranches(projectRoot));
    } catch (e) {
      setError(message(e));
    } finally {
      setFetching(false);
    }
  }, [fetching, onBranchesFetched]);

  const create = useCallback(async (projectRoot: string) => {
    const branch = newBranch.trim();
    if (!branch || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createProjectWorktree(projectRoot, branch);
      setNewBranchValue("");
      onWorktreeCreated(projectRoot, created.path, created.branch);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }, [busy, newBranch, onWorktreeCreated]);

  const remove = useCallback(async (projectRoot: string, removal: WorktreeRemoval) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await removeProjectWorktree(projectRoot, removal.path, removal.force);
      if (result === "needs-force") {
        // Dirty or has submodules: ask again, this time for a forced removal.
        setConfirmRemove({ path: removal.path, force: true });
        return;
      }
      setConfirmRemove(null);
      onWorktreeRemoved(projectRoot, removal.path);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }, [busy, onWorktreeRemoved]);

  return {
    busy,
    fetching,
    error,
    setError,
    confirmRemove,
    newBranch,
    setNewBranch,
    reset,
    requestRemove,
    cancelRemove,
    fetchBranches,
    create,
    remove,
  };
}

"use client";

import { useRef, useState } from "react";

import { isImeComposing } from "@/lib/ime";

/**
 * The topbar's title block. When `onRename` is given, clicking the title
 * swaps it for an input; Enter or losing focus applies, Escape cancels.
 */
export function TopBarTitle({
  title,
  subtitle,
  onRename,
  renameLabel,
}: {
  title: string;
  subtitle: string;
  onRename?: (name: string) => void;
  renameLabel?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Enter/Escape unmount the input, which can fire a trailing blur; only the
  // first exit of an edit counts.
  const doneRef = useRef(false);

  // The caller keys this by session, so a session switch drops the edit;
  // losing rename rights mid-edit drops it too.
  const isEditing = editing && Boolean(onRename);

  const startEdit = () => {
    if (!onRename) return;
    doneRef.current = false;
    setDraft(title);
    setEditing(true);
  };

  const finish = (apply: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    setEditing(false);
    const name = draft.trim();
    // An empty or unchanged title is not a rename.
    if (apply && name && name !== title) onRename?.(name);
  };

  return (
    <div className="app-topbar-title" title={isEditing ? undefined : title}>
      {isEditing ? (
        <input
          className="app-topbar-title-input"
          value={draft}
          aria-label={renameLabel}
          // Select on the autofocus itself, so keys typed right after the
          // click replace the title rather than land before a later select.
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(event) => {
            if (isImeComposing(event)) return;
            if (event.key === "Enter") {
              event.preventDefault();
              finish(true);
            } else if (event.key === "Escape") {
              // Keep Esc from also stopping the running agent.
              event.preventDefault();
              event.stopPropagation();
              finish(false);
            }
          }}
          autoFocus
        />
      ) : onRename ? (
        <span
          className="app-topbar-title-editable"
          role="button"
          tabIndex={0}
          aria-label={renameLabel ? `${renameLabel}: ${title}` : undefined}
          data-no-drag
          onClick={startEdit}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              startEdit();
            }
          }}
        >
          {title}
        </span>
      ) : (
        <span>{title}</span>
      )}
      <small>{subtitle}</small>
    </div>
  );
}

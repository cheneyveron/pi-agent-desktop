"use client";

import { useEffect, useId, useRef, useState } from "react";
import { openStackedDialog } from "@/lib/stacked-dialog";

/**
 * A small confirmation for the two chat decisions that deserve more than a click: letting a
 * chat use the computer, and deleting a chat together with its folder. It reuses the trust
 * dialog's look; Escape closes only this dialog, like there.
 */
export function ChatConfirmDialog({
  title,
  body,
  checkboxLabel,
  checkboxDefault = false,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
  error = null,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  /** An optional switch under the text; its value is handed to `onConfirm`. */
  checkboxLabel?: string;
  checkboxDefault?: boolean;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (checked: boolean) => void;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [checked, setChecked] = useState(checkboxDefault);
  const busyRef = useRef(busy);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    busyRef.current = busy;
    onCancelRef.current = onCancel;
  }, [busy, onCancel]);
  useEffect(() => openStackedDialog(document, dialogRef.current, () => {
    if (!busyRef.current) onCancelRef.current();
  }), []);

  return (
    <div
      role="presentation"
      className="project-trust-backdrop"
      onClick={(event) => {
        event.stopPropagation();
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        tabIndex={-1}
        className="project-trust-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="project-trust-body">
          <div className="project-trust-content">
            <div id={`${id}-title`} className="project-trust-title">{title}</div>
            <div id={`${id}-body`} className="project-trust-text">{body}</div>
            {checkboxLabel && (
              <label className="chat-confirm-check">
                <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} disabled={busy} />
                <span>{checkboxLabel}</span>
              </label>
            )}
          </div>
        </div>
        {error && <div role="alert" className="project-trust-error">{error}</div>}
        <div className="project-trust-footer">
          <button type="button" className="project-trust-button" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`project-trust-button is-primary${danger ? " is-danger" : ""}`}
            onClick={() => onConfirm(checked)}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

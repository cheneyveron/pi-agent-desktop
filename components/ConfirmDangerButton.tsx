"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

/** Destructive-action button that arms on first click and confirms on the second. */
export function ConfirmDangerButton({ label, busyLabel, busy, onConfirm, className, style }: {
  label: string;
  busyLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <button
      className={className ?? "native-button native-button-compact native-button-danger"}
      disabled={busy}
      aria-live="polite"
      style={armed ? { ...style, background: "var(--danger)", borderColor: "var(--danger)", color: "#fff" } : style}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
      onBlur={() => setArmed(false)}
    >
      {busy && busyLabel ? busyLabel : armed ? t("common.confirmDelete") : label}
    </button>
  );
}

"use client";

import { useI18n } from "@/hooks/useI18n";

/**
 * Shown above the composer when the model asked for a shell the chat does not have. One click
 * lets this chat use the computer and asks the model to carry on.
 */
export function ChatShellPrompt({
  busy,
  error,
  onAllow,
}: {
  busy: boolean;
  error: string | null;
  onAllow: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="chat-shell-prompt-wrap">
      <div className="chat-shell-prompt" role="status">
        <span className="chat-shell-prompt-text">{t("chat.chatShellPromptText")}</span>
        <button type="button" className="chat-shell-prompt-button" onClick={onAllow} disabled={busy} aria-busy={busy || undefined}>
          {t("chat.chatShellPromptAllow")}
        </button>
      </div>
      {error && <div role="alert" className="chat-shell-prompt-error">{error}</div>}
    </div>
  );
}

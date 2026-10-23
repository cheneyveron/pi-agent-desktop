"use client";

import { useI18n } from "@/hooks/useI18n";
import type { ChatAccessControls } from "@/hooks/useChatAccess";

/**
 * The chat rows of the composer's run menu: what this chat can do now, where its files are,
 * and the switch that lets it use the computer. A legacy chat (no folder) shows only the
 * description. The switch asks the parent, which holds the confirmation.
 */
export function ChatAccessRows({
  access,
  onToggleUnlocked,
}: {
  access: ChatAccessControls | null;
  onToggleUnlocked: (nextUnlocked: boolean) => void;
}) {
  const { t } = useI18n();
  const folder = access?.state.folder ?? null;
  const unlocked = access?.state.unlocked ?? false;
  // No answer yet means a chat that is about to start (every new chat gets a folder) or one
  // whose state is still loading; only the server's answer marks a legacy chat.
  const legacy = access !== null && access.state.folder === null;
  const description = unlocked
    ? t("chat.chatUnlockedDescription")
    : legacy ? t("chat.chatOnlyDescription") : t("chat.chatFolderDescription");

  return (
    <>
      <div
        className="composer-menu-row"
        role="menuitem"
        aria-disabled="true"
        data-active="true"
        title={description}
      >
        <span style={{ flex: 1 }}>{unlocked ? t("chat.chatUnlocked") : t("chat.chatWorkspace")}</span>
        <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8, whiteSpace: "normal", maxWidth: 260 }}>
          {description}
        </span>
      </div>
      {folder && (
        <button
          type="button"
          className="composer-menu-row"
          role="menuitem"
          onClick={() => void access?.reveal()}
          title={folder}
        >
          <span style={{ flex: 1 }}>{t("chat.chatFolderReveal")}</span>
        </button>
      )}
      {access?.state.available && (
        <button
          type="button"
          className="composer-menu-row"
          role="menuitemcheckbox"
          aria-checked={unlocked}
          disabled={access.busy}
          onClick={() => onToggleUnlocked(!unlocked)}
        >
          <span style={{ flex: 1 }}>{t("chat.chatUnlockToggle")}</span>
          <span
            className="chat-access-switch"
            data-on={unlocked || undefined}
            aria-hidden="true"
          />
        </button>
      )}
      {access?.error && (
        <div role="alert" style={{ padding: "4px 9px", fontSize: 11, color: "var(--danger)", whiteSpace: "normal", maxWidth: 320 }}>
          {access.error}
        </div>
      )}
    </>
  );
}

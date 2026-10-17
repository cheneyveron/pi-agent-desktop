import { isTauriDesktop } from "@/lib/desktop-updater";

async function copyWithExecCommand(text: string): Promise<void> {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(ta);
  if (!ok) throw new Error("Copy failed");
}

/** Copy text to the system clipboard (Tauri plugin on desktop, Clipboard API on web). */
export async function copyText(text: string): Promise<void> {
  if (isTauriDesktop()) {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
      return;
    } catch {
      // fall through to browser APIs
    }
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through
    }
  }

  await copyWithExecCommand(text);
}

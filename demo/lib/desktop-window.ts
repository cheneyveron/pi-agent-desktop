export type DesktopPlatform = "macos" | "windows" | "linux" | null;

/** Best-effort OS family for the desktop shell, used to pick window-chrome styling. */
export function getDesktopPlatform(): DesktopPlatform {
  if (typeof navigator === "undefined") return null;
  const platform = navigator.platform || "";
  if (/mac/i.test(platform)) return "macos";
  if (/win/i.test(platform)) return "windows";
  if (/linux/i.test(platform)) return "linux";
  return null;
}

export async function minimizeWindow(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().toggleMaximize();
}

export async function startDraggingWindow(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startDragging();
}

export async function closeWindow(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}

export async function isWindowMaximized(): Promise<boolean> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().isMaximized();
}

export { selectDirectoryNative } from "@/lib/desktop-native";

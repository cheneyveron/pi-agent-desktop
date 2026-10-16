/**
 * The OS family whose conventions the UI's dialogs follow, published as
 * `<html data-platform="…">` so `app/native-theme.css` can style the settings
 * dialog per platform. Unlike `getDesktopPlatform()` this also runs in a
 * browser, where a Windows user gets the same Windows layout as the desktop
 * app; phones and tablets get none (Android reports a Linux platform, and the
 * mobile layout has its own picker anyway).
 */
export type UiPlatform = "macos" | "windows" | "linux";

export const UI_PLATFORM_ATTRIBUTE = "data-platform";

interface NavigatorLike {
  platform?: string;
  userAgent?: string;
}

export function detectUiPlatform(nav: NavigatorLike | undefined): UiPlatform | null {
  if (!nav) return null;
  const platform = nav.platform ?? "";
  const userAgent = nav.userAgent ?? "";
  if (/android|iphone|ipad|ipod/i.test(`${platform} ${userAgent}`)) return null;
  if (/mac/i.test(platform)) return "macos";
  if (/win/i.test(platform)) return "windows";
  if (/linux/i.test(platform)) return "linux";
  return null;
}

/** Sets (or clears) the attribute on the document element; safe to call during SSR. */
export function applyUiPlatform(): UiPlatform | null {
  if (typeof document === "undefined" || typeof navigator === "undefined") return null;
  const platform = detectUiPlatform(navigator);
  if (platform) document.documentElement.setAttribute(UI_PLATFORM_ATTRIBUTE, platform);
  else document.documentElement.removeAttribute(UI_PLATFORM_ATTRIBUTE);
  return platform;
}

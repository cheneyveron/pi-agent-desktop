/**
 * Decides which surface a Ctrl/Cmd+F belongs to. The chat and the right-hand file
 * panel each own a find bar; the one under the mouse pointer wins, and when the
 * pointer is over neither (sidebar, topbar, no movement yet) keyboard focus
 * decides, then the chat.
 */

export type FindZone = "chat" | "file";

const ZONE_SELECTOR = "[data-find-zone]";

let pointer: { x: number; y: number } | null = null;
let tracking = false;

function trackPointer() {
  if (tracking || typeof window === "undefined") return;
  tracking = true;
  const remember = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    pointer = { x: event.clientX, y: event.clientY };
  };
  window.addEventListener("pointermove", remember, { capture: true, passive: true });
  window.addEventListener("pointerdown", remember, { capture: true, passive: true });
  // The pointer is gone once it leaves the window, so a later Ctrl+F falls back to focus.
  document.documentElement.addEventListener("pointerleave", () => { pointer = null; });
}

function zoneOf(element: Element | null | undefined): FindZone | null {
  const value = element?.closest(ZONE_SELECTOR)?.getAttribute("data-find-zone");
  return value === "chat" || value === "file" ? value : null;
}

export function resolveFindZone(): FindZone {
  trackPointer();
  if (pointer) {
    const hovered = zoneOf(document.elementFromPoint(pointer.x, pointer.y));
    if (hovered) return hovered;
  }
  return zoneOf(document.activeElement) ?? "chat";
}

/** Call once from each find owner so the pointer listener exists before the first shortcut. */
export function ensureFindZoneTracking(): void {
  trackPointer();
}

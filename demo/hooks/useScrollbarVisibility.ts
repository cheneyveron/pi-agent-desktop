import { useEffect, type RefObject } from "react";

const HIDE_DELAY_MS = 500;
// A scroll only reveals the thumb when the user caused it. Programmatic scrolls
// — landing a freshly loaded session at its bottom, restoring a saved position,
// following a streaming reply — would otherwise flash the thumb on every load
// and on every streamed chunk.
const USER_SCROLL_INTENT_MS = 800;

export function useScrollbarVisibility(ref: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;

    let element: HTMLElement | null = null;
    let attachFrame: number | null = null;
    let disposed = false;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const clearHideTimer = () => {
      if (hideTimer !== null) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    };
    const show = () => {
      if (!element) return;
      clearHideTimer();
      element.classList.add("scrollbar-visible");
    };
    const hideSoon = () => {
      if (!element) return;
      clearHideTimer();
      hideTimer = setTimeout(() => {
        hideTimer = null;
        element?.classList.remove("scrollbar-visible");
      }, HIDE_DELAY_MS);
    };
    let lastUserIntent = -Infinity;
    const markUserIntent = () => {
      lastUserIntent = performance.now();
    };
    const onScroll = () => {
      if (performance.now() - lastUserIntent > USER_SCROLL_INTENT_MS) return;
      show();
      hideSoon();
    };
    const intentEvents = ["wheel", "touchmove", "pointerdown", "keydown"] as const;

    const attach = () => {
      if (disposed) return;
      element = ref.current;
      if (!element) {
        attachFrame = requestAnimationFrame(attach);
        return;
      }
      element.addEventListener("pointerenter", show);
      element.addEventListener("pointerleave", hideSoon);
      element.addEventListener("scroll", onScroll);
      for (const type of intentEvents) element.addEventListener(type, markUserIntent, { passive: true });
    };
    attach();

    return () => {
      disposed = true;
      if (attachFrame !== null) cancelAnimationFrame(attachFrame);
      element?.removeEventListener("pointerenter", show);
      element?.removeEventListener("pointerleave", hideSoon);
      element?.removeEventListener("scroll", onScroll);
      for (const type of intentEvents) element?.removeEventListener(type, markUserIntent);
      clearHideTimer();
      element?.classList.remove("scrollbar-visible");
    };
  }, [enabled, ref]);
}

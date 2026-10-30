/**
 * Placement for the sidebar's fixed-position menus.
 *
 * The previous code estimated a menu's height from a constant (42px for the
 * project menu, a rough item count for the session menu). A guess that small
 * always reports "there is room below", so a menu opened near the bottom of
 * the window ran off the screen and its last items could not be clicked.
 * These helpers work from the menu's measured size instead.
 */

export interface MenuAnchor {
  /** Anchor rectangle in viewport coordinates. */
  top: number;
  bottom: number;
  right: number;
}

export interface MenuSize {
  width: number;
  height: number;
}

/** Gap between the anchor and the menu. */
export const MENU_GAP = 4;
/** Minimum distance kept between the menu and the viewport edge. */
export const MENU_MARGIN = 8;

/**
 * Place a menu next to its anchor: below it when there is room, above it when
 * there is not, and always fully inside the viewport.
 */
export function placeMenuWithinViewport(
  anchor: MenuAnchor,
  menu: MenuSize,
  viewport: { width: number; height: number },
  options: { gap?: number; margin?: number } = {},
): { top: number; left: number } {
  const gap = options.gap ?? MENU_GAP;
  const margin = options.margin ?? MENU_MARGIN;
  const maxLeft = Math.max(margin, viewport.width - menu.width - margin);
  const left = Math.min(Math.max(anchor.right - menu.width, margin), maxLeft);

  const below = anchor.bottom + gap;
  if (below + menu.height <= viewport.height - margin) return { top: below, left };

  const above = anchor.top - gap - menu.height;
  if (above >= margin) return { top: above, left };

  // Neither side fits: keep the menu on screen and let it scroll internally.
  return { top: Math.max(margin, viewport.height - margin - menu.height), left };
}

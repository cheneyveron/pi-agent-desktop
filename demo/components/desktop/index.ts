/**
 * Desktop-only UI, kept out of the components agegr/pi-web owns.
 *
 * Upstream files should reach this directory through a single import and mount
 * point. Anything here renders to nothing in a browser build, so the host does
 * not need its own `isTauriDesktop()` branch around it.
 *
 * See docs/ownership-boundaries.md.
 */

export { DesktopAppSection } from "./DesktopAppSection";
export { WindowControls } from "./WindowControls";
export { useDesktopChrome, type DesktopChrome } from "./useDesktopChrome";
export { useWindowDrag } from "./useWindowDrag";

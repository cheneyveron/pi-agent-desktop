// IME composition guard for key handlers. While a Chinese/Japanese/Korean
// candidate window is open, Enter commits the candidate and Escape cancels it —
// neither may submit, close a dialog, or abort a run. `isComposing` alone is not
// enough: WebKit (Safari and the macOS Tauri WebView) can report the key that
// ends a composition with `isComposing === false` and `keyCode === 229`.

interface KeyEventLike {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

/** True while the key event belongs to an IME composition (DOM or React event). */
export function isImeComposing(event: KeyEventLike): boolean {
  const native = event.nativeEvent ?? event;
  return Boolean(native.isComposing) || native.keyCode === 229;
}

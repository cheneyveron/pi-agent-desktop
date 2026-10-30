import type { ITheme } from "@xterm/xterm";

/** Read the same surface and semantic colors used by the surrounding workbench. */
export function terminalTheme(element: HTMLElement): ITheme {
  const style = getComputedStyle(element);
  const color = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: color("--surface"), foreground: color("--text"),
    cursor: color("--text"), cursorAccent: color("--surface"),
    selectionBackground: color("--selection"),
    black: color("--text"), brightBlack: color("--text-muted"),
    red: color("--danger"), brightRed: color("--danger"),
    green: color("--success"), brightGreen: color("--success"),
    yellow: color("--warning"), brightYellow: color("--warning"),
    blue: color("--info"), brightBlue: color("--info"),
    magenta: color("--terminal-magenta"), brightMagenta: color("--terminal-magenta"),
    cyan: color("--terminal-cyan"), brightCyan: color("--terminal-cyan"),
    white: color("--text"), brightWhite: color("--text"),
  };
}

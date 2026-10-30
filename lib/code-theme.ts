import { vs } from "react-syntax-highlighter/dist/esm/styles/prism";

// One restrained syntax palette for both colour modes. Prism's stock `vs` /
// `vscDarkPlus` themes use five-plus saturated hues; this keeps layout from
// `vs` and recolours every token from three theme variables (--code-accent,
// --code-warm, --code-comment in native-theme.css), so a light/dark switch is
// a CSS change and the highlighter never re-renders for it.
type Style = Record<string, string | number>;

const TEXT = "var(--text)";
const MUTED = "var(--text-muted)";
const ACCENT = "var(--code-accent)";
const WARM = "var(--code-warm)";
const COMMENT = "var(--code-comment)";

const GROUPS: Array<[RegExp, string, Style?]> = [
  [/(^|\.)(comment|prolog|doctype|cdata)(\W|$)/, COMMENT],
  [/(^|\.)(punctuation|operator|namespace)(\W|$)/, MUTED],
  [/(^|\.)(important|bold)(\W|$)/, TEXT, { fontWeight: "bold" }],
  [/(^|\.)(keyword|atrule|tag|selector|builtin|directive|function|class-name)(\W|$)/, ACCENT],
  [/(^|\.)(string|attr-value|url|regex|inserted|char|number|boolean|constant|symbol)(\W|$)/, WARM],
  [/(^|\.)deleted(\W|$)/, "var(--danger)"],
];

function recolour(key: string, base: Style): Style {
  const style: Style = { ...base };
  delete style.background;
  delete style.backgroundColor;
  delete style.textShadow;
  const token = key.split(" ").pop() ?? key;
  for (const [pattern, color, extra] of GROUPS) {
    if (pattern.test(token)) return { ...style, color, ...extra };
  }
  if (key === "italic") return { ...style, fontStyle: "italic" };
  return { ...style, color: TEXT };
}

const LAYOUT_KEYS = new Set(['code[class*="language-"]', 'pre[class*="language-"]']);

export const calmCodeTheme: Record<string, Style> = Object.fromEntries(
  Object.entries(vs as Record<string, Style>).map(([key, base]) => {
    if (LAYOUT_KEYS.has(key)) {
      const layout: Style = { ...base, color: TEXT };
      for (const drop of ["border", "background", "backgroundColor"]) delete layout[drop];
      return [key, layout];
    }
    if (key.includes("selection") || key.includes("line-numbers") || key.includes("line-highlight") || key.startsWith("pre >") || key.startsWith(":not(pre)")) return [key, base];
    return [key, recolour(key, base)];
  }),
);

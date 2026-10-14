import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { isArtifactsPromptEnabled } from "./artifact-settings";

export const ARTIFACT_GUIDE_EXTENSION_NAME = "pi-web-artifacts";
export const ARTIFACT_GUIDE_SECTION = "artifacts";

// Tells the model the `:::artifact` syntax lib/artifacts.ts parses. Kept short
// because it is sent with every request; the "when not to" lines matter as
// much as the format, or every code answer turns into a panel.
export const ARTIFACT_GUIDE = `Replies are shown in Pi Web, which renders an artifact block in a side panel next to the chat. Use an artifact only when the user benefits from viewing or interacting with standalone content: a complete HTML page, app, game, visualization or dashboard; a React component; an SVG image; a Mermaid diagram; or a long self-contained document they will reuse. Do not use one for short snippets, explanations, answers that fit in the message, or changes to project files (edit those with tools).

Format (the inner code fence is required):
:::artifact{identifier="tip-calculator" type="html" title="Tip calculator"}
\`\`\`html
<!DOCTYPE html>
...
\`\`\`
:::

- type: html, react, svg, mermaid, markdown, or code (for code, put the language on the inner fence).
- react: one JSX/TSX module whose default export is the component, with no required props. Import React hooks from "react" and any npm package by name (loaded from esm.sh, e.g. lucide-react, recharts); no local or "@/..." imports. Style with Tailwind classes.
- To change an artifact, output the whole artifact again with the same identifier; it becomes a new version. Use a new identifier for unrelated content.
- HTML must be one complete file. It runs in a sandboxed frame with no access to this app, the user's files or cookies, and storage that resets on reload. Scripts and styles may load from public CDNs (cdnjs.cloudflare.com, cdn.jsdelivr.net) but can be unavailable offline.
- Keep commentary outside the block, usually one or two sentences.`;

/**
 * Adds the `<artifacts>` prompt section to every run of a normal Pi Web
 * session. The switch in Settings › General is read on each run, so turning
 * it off removes the section from the next prompt without a reload (the SDK
 * diffs sections and records the removal in the transcript).
 */
export function createArtifactGuideExtension(
  isEnabled: () => boolean = isArtifactsPromptEnabled,
): InlineExtension {
  return {
    name: ARTIFACT_GUIDE_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (event) => {
        if (isEnabled()) event.systemPromptOptions.sections[ARTIFACT_GUIDE_SECTION] = ARTIFACT_GUIDE;
        else delete event.systemPromptOptions.sections[ARTIFACT_GUIDE_SECTION];
        return undefined;
      });
    },
  };
}

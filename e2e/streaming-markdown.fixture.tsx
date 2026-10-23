import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MarkdownBody } from "../components/MarkdownBody";
import { I18nProvider } from "../hooks/useI18n";
import { markdownRemarkPlugins } from "../lib/markdown";

const metrics = { parses: 0, parsedChars: 0, stableParses: 0, longTasks: [] as number[] };
const measureMarkdown = () => (_tree: unknown, file: { value: unknown }) => {
  const text = String(file.value);
  metrics.parses++;
  metrics.parsedChars += text.length;
  if (text.includes("Stable section")) metrics.stableParses++;
};
markdownRemarkPlugins?.push(measureMarkdown);
if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
  new PerformanceObserver((entries) => {
    metrics.longTasks.push(...entries.getEntries().map((entry) => entry.duration));
  }).observe({ type: "longtask" });
}

const openFile = (path: string) => { document.documentElement.dataset.openedFile = path; };
function Fixture() {
  const [{ text, streaming }, setMessage] = useState({ text: "", streaming: false });
  Object.assign(window, {
    markdownFixture: {
      set(text: string, streaming = true) { flushSync(() => setMessage({ text, streaming })); },
      metrics,
      resetMetrics() { Object.assign(metrics, { parses: 0, parsedChars: 0, stableParses: 0, longTasks: [] }); },
    },
  });
  return (
    <I18nProvider>
      <main style={{ maxWidth: 850, margin: "32px auto", padding: 20 }}>
        <label htmlFor="draft">Draft during streaming</label>
        <input id="draft" style={{ display: "block", width: "100%", marginBottom: 24 }} />
        <MarkdownBody isStreaming={streaming} cwd="/project" onOpenFile={openFile} artifacts>{text}</MarkdownBody>
      </main>
    </I18nProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);

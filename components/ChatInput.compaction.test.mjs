import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function render(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onCompact() {},
        onAbortCompaction() {},
        isStreaming: false,
        ...props,
      }),
    ),
  );
}

test("auto-compaction mid-run stays visible with a stop control", () => {
  const html = render({ isStreaming: true, isCompacting: true });
  assert.match(html, /Compacting…/);
  assert.match(html, /title="Stop compaction"/);
});

test("manual compact is offered from the session menu when idle and hidden while merely streaming", () => {
  // The menu content is not in static markup (closed), so the gear that opens
  // it stands for the offer: with no automation values yet, only compaction
  // can be what puts it there.
  const idle = render({ isStreaming: false });
  assert.match(idle, /aria-label="Session automation"/);
  assert.doesNotMatch(idle, /Compacting…/);

  const streaming = render({ isStreaming: true, isCompacting: false });
  assert.doesNotMatch(streaming, /aria-label="Session automation"/);
  assert.doesNotMatch(streaming, /Compacting…/);
});

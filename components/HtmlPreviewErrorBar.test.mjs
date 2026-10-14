import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { HtmlPreviewErrorBar, formatPreviewErrors } = await jiti.import("./HtmlPreviewErrorBar.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const render = (props) => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(HtmlPreviewErrorBar, props)));

test("fences errors so backticks inside cannot close the block", () => {
  assert.equal(formatPreviewErrors(["a", "b"]), "```\na\nb\n```");
  assert.equal(formatPreviewErrors(["x ``` y"]), "````\nx ``` y\n````");
});

test("renders nothing without errors and offers a fix only when possible", () => {
  assert.equal(render({ errors: [], onDismiss() {} }), "");
  const withFix = render({ errors: ["boom", "bang"], onFix() {}, onDismiss() {} });
  assert.match(withFix, /role="alert"/);
  assert.match(withFix, /boom/);
  assert.match(withFix, /\+1 more/);
  assert.match(withFix, /Ask to fix/);
  assert.doesNotMatch(render({ errors: ["boom"], onDismiss() {} }), /Ask to fix/);
});

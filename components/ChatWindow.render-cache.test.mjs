import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { getFinalSplit, getTurnWrittenFiles } = await jiti.import("./ChatWindow.tsx");
const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const markdownSource = await readFile(new URL("./MarkdownBody.tsx", import.meta.url), "utf8");

// MessageView's memo compares `message` and `writtenFiles` by identity. The
// transcript loop re-runs on every streaming delta, so every finished turn must
// get the same derived objects back, or each token re-renders the whole history.

test("final answer and process messages are stable per assistant message", () => {
  const final = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "plan" },
      { type: "toolCall", toolCallId: "t1", toolName: "write", input: { path: "a.txt", content: "x" } },
      { type: "text", text: "Done." },
    ],
    usage: { input: 1, output: 1 },
  };
  const first = getFinalSplit(final);
  const second = getFinalSplit(final);
  assert.equal(second, first);
  assert.equal(second.answerMessage, first.answerMessage);
  assert.equal(second.processMessage, first.processMessage);
  assert.deepEqual(first.answerMessage.content.map((block) => block.type), ["text"]);
  assert.equal(first.processMessage.usage, undefined, "usage belongs to the answer bubble");

  const errorOnly = { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" };
  assert.ok(getFinalSplit(errorOnly).answerMessage, "an error-only final entry still renders its notice");
});

test("a turn's written-files list keeps its identity until its inputs change", () => {
  const call = { role: "assistant", content: [{ type: "toolCall", toolCallId: "w1", toolName: "write", input: { path: "/p/out.txt", content: "x" } }] };
  const final = { role: "assistant", content: [{ type: "text", text: "ok" }] };
  const results = new Map([["w1", { role: "toolResult", toolCallId: "w1", toolName: "write", content: [], isError: false }]]);
  const files = getTurnWrittenFiles(final, [call, final], results, "/p");
  assert.deepEqual(files.map((file) => file.filePath), ["/p/out.txt"]);
  assert.equal(getTurnWrittenFiles(final, [call, final], results, "/p"), files);
  // A new (but equivalent) tool-results map must not invalidate the list.
  assert.equal(getTurnWrittenFiles(final, [call, final], new Map(results), "/p"), files);
});

test("the transcript loop reads the caches instead of re-deriving per render", () => {
  const loop = source.slice(source.indexOf("const rendered: ReactNode[] = [];"));
  assert.match(loop, /getFinalSplit\(finalAssistant\)/);
  assert.match(loop, /getTurnWrittenFiles\(finalAssistant,/);
  assert.doesNotMatch(loop, /splitFinalAssistantBlocks\(|withAssistantBlocks\(|extractTurnWrittenFiles\(/);
});

test("streaming markdown snapshots are coalesced and the renderer element memoized", () => {
  assert.match(markdownSource, /const markdown = useStreamingMarkdownText\(children, Boolean\(isStreaming\)\);/);
  assert.match(markdownSource, /const body = useMemo\(\(\) => \(\s*<StreamingMarkdown/);
});

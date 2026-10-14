import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { artifactPanelTab, artifactTabId, artifactTabsForSession, upsertArtifactTab } = await jiti.import("./artifact-tabs.ts");
const { publishSessionArtifacts, resetArtifactStore } = await jiti.import("@/lib/artifact-store");

test("keeps one tab per artifact and re-targets it on reopen", () => {
  let tabs = upsertArtifactTab([], { sessionId: "s", identifier: "a", title: "A" }, 1);
  tabs = upsertArtifactTab(tabs, { sessionId: "s", identifier: "a", title: "A", version: 1 }, 2);
  tabs = upsertArtifactTab(tabs, { sessionId: "s", identifier: "b", title: "B" }, 3);
  assert.deepEqual(tabs.map((tab) => tab.id), [artifactTabId("s", "a"), artifactTabId("s", "b")]);
  assert.deepEqual(tabs[0].versionRequest, { version: 1, nonce: 2 });
});

test("labels the tab with the newest version's title", () => {
  resetArtifactStore();
  const [tab] = upsertArtifactTab([], { sessionId: "s", identifier: "a", title: "Old" }, 1);
  assert.equal(artifactPanelTab(tab).label, "Old");
  publishSessionArtifacts("s", [{ identifier: "a", versions: [
    { title: "Old", type: "html", lang: "html", content: "1", complete: true },
    { title: "Renamed", type: "html", lang: "html", content: "2", complete: true },
  ] }]);
  assert.equal(artifactPanelTab(tab).label, "Renamed");
  assert.equal(artifactPanelTab(tab).kind, "artifact");
});

test("switching conversations keeps only that conversation's artifact tabs", () => {
  let tabs = upsertArtifactTab([], { sessionId: "a", identifier: "x", title: "X" }, 1);
  tabs = upsertArtifactTab(tabs, { sessionId: "b", identifier: "y", title: "Y" }, 2);
  assert.deepEqual(artifactTabsForSession(tabs, "b").map((tab) => tab.id), [artifactTabId("b", "y")]);
  assert.deepEqual(artifactTabsForSession(tabs, null), []);
  const unchanged = [tabs[0]];
  assert.equal(artifactTabsForSession(unchanged, "a"), unchanged, "nothing removed returns the same array");
});

import assert from "node:assert/strict";

export const findTargetFixture = `${"filler line\n".repeat(40)}first needle here\nsecond Needle there\n${"filler line\n".repeat(40)}third needle at the end\n`;

// Ctrl/Cmd+F searches whichever of the chat and the open file the pointer is over.
export async function checkFindInPage(page, filePath) {
  const panel = page.locator("#file-panel");
  const hideSidebar = page.getByRole("button", { name: "Hide sidebar", exact: true });
  if (await page.locator("#session-sidebar").evaluate((element) => element.classList.contains("sidebar-open"))) {
    await hideSidebar.click();
  }
  await page.locator('.app-topbar button[aria-label="Show workspace"]').click();
  await panel.waitFor({ state: "visible" });
  const showFileList = panel.locator('.file-tree-toggle[aria-label="Show file list"]');
  if (await showFileList.isVisible()) await showFileList.click();
  await panel.locator(`[role="button"][title="${filePath}"]`).click();
  const content = panel.locator(".file-viewer-content");
  await content.waitFor();
  await content.getByText("third needle at the end").waitFor();

  const highlightSize = (name) => page.evaluate((key) => CSS.highlights.get(key)?.size ?? 0, name);

  // Pointer over the file: the file panel's bar opens, the chat's does not.
  await content.hover();
  await page.keyboard.press("Control+f");
  const fileBar = panel.locator(".find-bar");
  await fileBar.waitFor();
  assert.equal(await page.locator('[data-find-zone="chat"] .find-bar').count(), 0);
  assert.equal(await fileBar.locator("input").evaluate((el) => el === document.activeElement), true);
  await page.keyboard.type("needle");
  await fileBar.locator(".find-bar-count", { hasText: "1/3" }).waitFor();
  assert.equal(await highlightSize("file-find"), 3, "Case-insensitive search finds every match");
  assert.equal(await highlightSize("file-find-current"), 1);
  await page.keyboard.press("Enter");
  await fileBar.locator(".find-bar-count", { hasText: "2/3" }).waitFor();
  await page.keyboard.press("Shift+Enter");
  await fileBar.locator(".find-bar-count", { hasText: "1/3" }).waitFor();
  await fileBar.getByRole("button", { name: "Match case", exact: true }).click();
  await fileBar.locator(".find-bar-count", { hasText: "1/2" }).waitFor();
  await page.keyboard.press("Escape");
  await fileBar.waitFor({ state: "detached" });
  assert.equal(await highlightSize("file-find"), 0, "Closing clears the highlights");

  // Pointer over the conversation: the chat's bar opens instead.
  await page.locator(".chat-scroll-container").hover();
  await page.keyboard.press("Control+f");
  const chatBar = page.locator('[data-find-zone="chat"] .find-bar');
  await chatBar.waitFor();
  assert.equal(await panel.locator(".find-bar").count(), 0);
  await page.keyboard.type("E2E answer paragraph");
  await chatBar.locator(".find-bar-count", { hasText: /^1\/\d+$/ }).waitFor();
  assert.ok(await highlightSize("file-find") >= 20, "Chat matches are highlighted");
  await page.keyboard.press("Escape");
  await chatBar.waitFor({ state: "detached" });

  await page.locator('.app-topbar button[aria-label="Hide workspace"]').click();
  console.log("PASS: Ctrl/Cmd+F searches the chat or the open file by pointer position");
}

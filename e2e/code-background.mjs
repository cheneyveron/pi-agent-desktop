import assert from "node:assert/strict";

/** The fixture has one ordinary fence and one Mermaid diagram. */
export async function checkCodeBackground(page) {
  const warnings = [];
  const onConsole = (message) => {
    if (/conflicting property|style property during rerender/.test(message.text())) {
      warnings.push(message.text());
    }
  };
  page.on("console", onConsole);
  const source = page.getByRole("button", { name: "Source", exact: true });
  await source.click();
  const blocks = page.locator(".markdown-code-block pre");
  await blocks.nth(1).waitFor();
  try {
    for (const colorScheme of ["light", "dark", "light", "dark", "light"]) {
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, colorScheme);
      await page.waitForFunction(() => {
        // Probe inside the chat: the main column re-points --bg at the
        // workbench surface, so body-level tokens resolve differently.
        const host = document.querySelector(".markdown-code-block");
        if (!host) return false;
        const probe = document.createElement("div");
        probe.style.backgroundColor = "color-mix(in srgb, var(--bg) 92%, var(--bg-panel))";
        host.append(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const nodes = [...document.querySelectorAll(".markdown-code-block pre")];
        return nodes.length === 2 && nodes.every((node) => (
          getComputedStyle(node).backgroundColor === expected
          && getComputedStyle(node).borderTopWidth === "0px"
          && getComputedStyle(node.querySelector("code")).backgroundColor === "rgba(0, 0, 0, 0)"
        ));
      });
    }
    await checkCodeSelection(page, blocks.first());
    assert.deepEqual(warnings, [], "Theme switches must not mix background shorthand and backgroundColor");
  } finally {
    page.off("console", onConsole);
    await page.emulateMedia({ colorScheme: "light" });
  }
  console.log("PASS: code and Mermaid source backgrounds survive repeated theme switches");
}

/** Actual pointer selection across a multi-line highlighted fence. Also used by
 * the standalone browser replay so this assertion can run without a Next build.
 * Numeric source lines are intentional: stripping /^\d+/ would corrupt them. */
export async function checkCodeSelection(page, block = page.locator(".markdown-code-block pre").first()) {
  const expected = "const values = [\n  123,\n\n  456,\n];\nconsole.log(values);";
  await block.scrollIntoViewIfNeeded();
  // Derive pointer coordinates from actual glyph rectangles rather than fixed
  // font metrics. This keeps the drag valid across themes, platforms and font
  // settings, while excluding the gutter from the start/end text-node search.
  const points = await block.evaluate((pre) => {
    const numbers = [...pre.querySelectorAll(".react-syntax-highlighter-line-number")];
    if (numbers.length < 6) throw new Error("selection fixture must contain six numbered lines");
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.data.length && !node.parentElement.closest(".react-syntax-highlighter-line-number")) nodes.push(node);
    }
    const start = document.createRange(); start.setStart(nodes[0], 0); start.setEnd(nodes[0], 1);
    const last = nodes.at(-1);
    const end = document.createRange(); end.setStart(last, last.length - 1); end.setEnd(last, last.length);
    const a = start.getBoundingClientRect(), b = end.getBoundingClientRect();
    return { start: { x: a.left + .1, y: a.top + a.height / 2 },
      end: { x: b.right - .1, y: b.top + b.height / 2 },
      selectableGutter: numbers.some((node) => getComputedStyle(node).userSelect !== "none") };
  });
  assert.equal(points.selectableGutter, false);
  try {
    // Crossing multiple lines in both directions reproduces the reported
    // interaction; a programmatic Range alone would not exercise pointer hit
    // testing. Compare exact source so legitimate numeric lines remain intact.
    for (const reverse of [false, true]) {
      await page.evaluate(() => getSelection().removeAllRanges());
      const from = reverse ? points.end : points.start;
      const to = reverse ? points.start : points.end;
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 20 }); await page.mouse.up();
      assert.equal(await page.evaluate(() => getSelection().toString()), expected,
        `${reverse ? "reverse" : "forward"} drag must preserve code, indentation, blank and numeric lines without gutter numbers`);
    }
  } finally {
    // Do not leave a pressed pointer or selection behind for later E2E checks,
    // including when an assertion fails halfway through a drag.
    await page.mouse.up();
    await page.evaluate(() => getSelection().removeAllRanges());
  }
}

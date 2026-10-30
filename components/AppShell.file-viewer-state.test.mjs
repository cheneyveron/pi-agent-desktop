import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

function fileContentBlock() {
  const start = source.indexOf("{/* Only the active viewer");
  // The fork's right panel appends an always-on file-tree column after the
  // viewer, so the block ends at the tree conditional's close instead. The
  // panel (with the viewer inside it) closes inside the inner row, so the
  // sequence is panel close → inner row close (the older shapes are kept as
  // fallbacks for merge resilience; the layout itself is pinned by
  // AppShell.right-panel-row.test.mjs).
  let end = source.indexOf("</>\n          )}\n      </div>\n        </div>", start);
  if (end === -1) end = source.indexOf("</>\n          )}\n      </div>\n      </div>", start);
  if (end === -1) end = source.indexOf("</>\n          )}\n      </div>\n    </div>", start);
  assert.notEqual(start, -1, "file content comment not found");
  assert.notEqual(end, -1, "end of file content block not found");
  return source.slice(start, end);
}

test("only the active file tab mounts a FileViewer", () => {
  const block = fileContentBlock();
  assert.match(block, /activeFileTab\?\.filePath \? \(/);
  assert.doesNotMatch(block, /fileTabs\.map\(/);
  assert.equal(block.match(/<FileViewer/g)?.length, 1);
});

test("the active viewer restores tab state and saves it with a revision", () => {
  const block = fileContentBlock();
  assert.match(block, /key=\{`\$\{activeFileTab\.id\}:\$\{activeFileTab\.viewerRevision \?\? 0\}`\}/);
  assert.match(block, /initialState=\{activeFileTab\.viewerState\}/);
  assert.match(block, /handleFileViewerStateChange\(\s*activeFileTab\.id,\s*activeFileTab\.viewerRevision \?\? 0,/);
});

test("closing the file panel pauses the active viewer watcher", () => {
  assert.match(fileContentBlock(), /watchEnabled=\{rightPanelOpen\}/);
});

test("markdown preview links forward a PDF page fragment to the viewer", () => {
  const block = fileContentBlock();
  assert.match(block, /onOpenFile=\{\(filePath, page\) => handleOpenFile\(/);
  assert.match(block, /\{ sourceSessionId: activeFileTab\.sourceSessionId, page \}/);
});

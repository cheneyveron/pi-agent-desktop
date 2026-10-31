import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { userImageDisplayText } = await jiti.import("./user-image-display.ts");
const note = "[Image: original 2100x1180, displayed at 2000x1124. Multiply coordinates by 1.05 to map to original image.]";

test("hides SDK dimension suffixes only for attached images", () => {
  assert.equal(userImageDisplayText(`你好\n\n${note}`, 1), "你好");
  assert.equal(userImageDisplayText(`\n\n${note}`, 1), "");
  assert.equal(userImageDisplayText(`你好\n\n${note}\n${note}`, 2), "你好");
  assert.equal(userImageDisplayText(`你好\n\n${note}`, 0), `你好\n\n${note}`);
});
test("preserves quoted, fenced, embedded, malformed and excess hints", () => {
  for (const text of [`请解释 ${note}`, `引用\n\n${note}\n后续正文`, `\`\`\`text\n${note}\n\`\`\``, `> ${note}`, `你好\n\n${note}\n${note.replace("1.05", "1.06")}`, `你好\n\n${note.replace("1.05", "invalid")}`]) {
    assert.equal(userImageDisplayText(text, 1), text);
  }
  assert.equal(userImageDisplayText("  保留空白  \n", 1), "  保留空白  \n");
});

test("does not remove SDK-shaped text inside an unfinished fenced block", () => {
  const fenced = "```text\nexample\n\n" + note;
  assert.equal(userImageDisplayText(fenced, 1), fenced);
  const closed = fenced + "\n```";
  assert.equal(userImageDisplayText(closed, 1), closed);
});

test("removes repeated and mixed-separator SDK suffix groups", () => {
  assert.equal(userImageDisplayText(`hello\n\n${note}\n\n${note}`, 1), "hello");
  assert.equal(userImageDisplayText(`hello\n\n${note}\n${note}`, 2), "hello");
});

test("fences respect marker length, type, indentation and valid closing lines", () => {
  for (const prefix of ["```text\n", "~~~text\n", "   ```text\n", "````text\n```\n", "~~~\n```\n", "```\n```not-a-close\n"]) {
    const text = prefix + `example\n\n${note}`;
    assert.equal(userImageDisplayText(text, 1), text);
  }
  const body = "````text\nexample\n`````";
  assert.equal(userImageDisplayText(body + `\n\n${note}`, 1), body);
});

test("conversion hints and dimensions describe one attachment", () => {
  const conversion = "[Image converted from image/tiff to image/png.]";
  assert.equal(userImageDisplayText(`hello\n\n${conversion}\n${note}`, 1), "hello");
  assert.equal(userImageDisplayText(`hello\n\n${conversion}`, 1), "hello");
  assert.equal(userImageDisplayText(`hello\n\n${conversion}\n${note}\n${note}`, 2), "hello");
  assert.equal(userImageDisplayText(`hello\n\n${conversion}\n${note}\n${note}`, 1), `hello\n\n${conversion}\n${note}\n${note}`);
});

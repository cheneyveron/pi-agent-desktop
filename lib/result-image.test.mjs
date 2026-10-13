import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { imageSource } = await jiti.import("./result-image.ts");

test("builds a data URL once per block and reuses it", () => {
  const block = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
  const first = imageSource(block);
  assert.equal(first, "data:image/png;base64,AAAA");
  assert.equal(imageSource(block), first);
});

test("understands deferred URL blocks and pi-ai's flat shape", () => {
  assert.equal(imageSource({ type: "image", source: { type: "url", url: "/api/x" } }), "/api/x");
  assert.equal(imageSource({ type: "image", data: "BBBB", mimeType: "image/jpeg" }), "data:image/jpeg;base64,BBBB");
  assert.equal(imageSource({ type: "image" }), "");
});

test("a block edited in place is rebuilt, not served stale", () => {
  const block = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
  imageSource(block);
  block.source.data = "CCCC";
  assert.equal(imageSource(block), "data:image/png;base64,CCCC");
  block.source = { type: "url", url: "/u" };
  assert.equal(imageSource(block), "/u");
});

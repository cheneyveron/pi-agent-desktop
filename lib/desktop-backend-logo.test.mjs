import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../desktop/backend-logo.js", import.meta.url), "utf8");

function loadLogoScript() {
  let layoutReads = 0;
  let observerCallback;
  const frames = [];
  const element = () => ({
    style: {},
    attributes: new Map(),
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    setAttribute(name, value) { this.attributes.set(name, value); },
    addEventListener() {},
    matches: () => true,
    getBoundingClientRect() {
      layoutReads++;
      return { width: 40, right: 40, bottom: 20, left: 0 };
    },
  });
  const logo = element();
  const context = {
    navigator: { language: "en-US", platform: "MacIntel" },
    Element: class {},
    MutationObserver: class {
      constructor(callback) { observerCallback = callback; }
      observe() {}
    },
    requestAnimationFrame: (callback) => frames.push(callback),
    document: {
      readyState: "complete",
      body: { append() {} },
      addEventListener() {},
      createElement: element,
      querySelectorAll: () => [logo],
    },
  };
  context.window = context;
  context.window.innerWidth = 1024;
  context.window.addEventListener = () => {};
  context.top = context;
  vm.runInNewContext(source, context);
  return {
    get layoutReads() { return layoutReads; },
    mutate: () => observerCallback([]),
    flushFrame: () => frames.splice(0).forEach((callback) => callback()),
  };
}

test("backend logo bridge coalesces DOM mutations into one layout read per frame", () => {
  const logo = loadLogoScript();
  const initialReads = logo.layoutReads;

  for (let i = 0; i < 50; i++) logo.mutate();
  assert.equal(logo.layoutReads, initialReads, "mutation callbacks must not force layout synchronously");

  logo.flushFrame();
  assert.equal(logo.layoutReads, initialReads + 1);

  logo.mutate();
  logo.flushFrame();
  assert.equal(logo.layoutReads, initialReads + 2, "a later mutation schedules a fresh check");
});

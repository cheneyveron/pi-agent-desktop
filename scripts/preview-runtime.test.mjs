import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// public/preview-runtime/ is generated and committed. These checks fail when a
// dependency was bumped without `npm run preview-runtime`, or when a file
// would not work once inlined into a preview document.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(root, "public", "preview-runtime");
const require = createRequire(join(root, "package.json"));
const manifest = JSON.parse(await readFile(join(runtimeDir, "manifest.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));

test("the bundled runtime matches the locked dependency versions", () => {
  for (const [name, version] of Object.entries(manifest.versions)) {
    assert.equal(
      lock.packages[`node_modules/${name}`]?.version,
      version,
      `${name} in package-lock.json differs from public/preview-runtime — run \`npm run preview-runtime\`.`,
    );
  }
});

test("every runtime file exists with the size the manifest records", async () => {
  assert.deepEqual(Object.keys(manifest.files).sort(), ["react.js", "sucrase.js", "tailwind.js"]);
  for (const [file, size] of Object.entries(manifest.files)) {
    assert.equal((await stat(join(runtimeDir, file))).size, size, `${file} changed since it was generated`);
  }
});

test("the classic scripts set the globals the import map re-exports", async () => {
  process.env.NODE_ENV = "production";
  // Inert timers: React's scheduler would otherwise hold a real MessageChannel
  // open and keep the test process alive. Nothing here schedules work.
  class InertChannel {
    port1 = { onmessage: null };
    port2 = { postMessage() {} };
  }
  const context = vm.createContext({
    console,
    queueMicrotask,
    setTimeout: () => 0,
    clearTimeout: () => {},
    MessageChannel: InertChannel,
    window: {},
    self: {},
  });
  context.globalThis = context;
  vm.runInContext(await readFile(join(runtimeDir, "react.js"), "utf8"), context);
  vm.runInContext(await readFile(join(runtimeDir, "sucrase.js"), "utf8"), context);
  const runtime = context.__piPreviewRuntime;
  for (const [specifier, { global, exports }] of Object.entries(manifest.modules)) {
    const exported = runtime[global];
    assert.ok(exported, `__piPreviewRuntime.${global} is missing`);
    const actual = Object.keys(require(specifier)).filter((key) => key !== "default").sort();
    assert.deepEqual(exports, actual, `manifest exports for ${specifier} are stale`);
    for (const name of exports) {
      assert.ok(name in (exported.default ?? exported), `${specifier} lost ${name}`);
    }
  }
  const { code } = context.__piSucrase.transform("export default () => <p>hi</p>;", {
    transforms: ["jsx", "typescript"],
    jsxRuntime: "automatic",
    production: true,
  });
  assert.match(code, /from "react\/jsx-runtime"/);
});

test("the runtime is revalidated so an app update takes effect", async () => {
  const config = await readFile(join(root, "next.config.ts"), "utf8");
  assert.match(config, /source: "\/preview-runtime\/:path\*"[\s\S]*?max-age=0, must-revalidate/);
});

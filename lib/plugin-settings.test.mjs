import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-web-plugin-settings-"));
const home = join(root, "home");
const outside = join(root, "outside");
await mkdir(home, { recursive: true });
await mkdir(outside, { recursive: true });
const previousHome = process.env.PI_AGENT_HOME;
process.env.PI_AGENT_HOME = home;
after(async () => {
  if (previousHome === undefined) delete process.env.PI_AGENT_HOME;
  else process.env.PI_AGENT_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const {
  describePluginSettings,
  expandSettingsFilePath,
  PluginSettingsError,
  PluginSettingsValidationError,
  readPluginSettings,
  writePluginSettings,
} = await jiti.import("./plugin-settings.ts");

const schema = {
  type: "object",
  required: ["url"],
  properties: {
    url: { type: "string", format: "uri" },
    token: { type: "string", format: "password" },
    limit: { type: "integer", minimum: 1 },
  },
};

let counter = 0;
async function makePackage({ file = "~/.example/config.json", schemaPath = "./settings.schema.json", schemaDoc = schema, declare = true } = {}) {
  const dir = join(root, `pkg-${counter++}`);
  await mkdir(dir, { recursive: true });
  const pi = { extensions: ["index.js"] };
  if (declare) pi.settings = { file, schema: schemaPath };
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "example", version: "1.0.0", pi }));
  if (schemaDoc !== null) await writeFile(join(dir, "settings.schema.json"), JSON.stringify(schemaDoc));
  return dir;
}

const configPath = join(home, ".example", "config.json");

test("a package without a declaration has no settings", async () => {
  const pkg = await makePackage({ declare: false });
  assert.equal(describePluginSettings(pkg), undefined);
  assert.equal(describePluginSettings(undefined), undefined);
  assert.throws(() => readPluginSettings(pkg), (error) => error.status === 404);
});

test("describes an available package with the expanded file", async () => {
  assert.deepEqual(describePluginSettings(await makePackage()), { file: configPath, available: true });
});

test("reports a missing or invalid schema as unavailable with a reason", async () => {
  const missing = describePluginSettings(await makePackage({ schemaDoc: null }));
  assert.equal(missing.available, false);
  assert.match(missing.error, /was not found/);
  const broken = describePluginSettings(await makePackage({ schemaDoc: { type: "array" } }));
  assert.equal(broken.available, false);
  assert.match(broken.error, /type "object"/);
});

test("refuses schema paths that leave the package", async () => {
  await writeFile(join(outside, "schema.json"), JSON.stringify(schema));
  for (const schemaPath of ["../outside/schema.json", join(outside, "schema.json"), "sub/../../x.json"]) {
    const info = describePluginSettings(await makePackage({ schemaPath }));
    assert.equal(info.available, false, schemaPath);
    assert.match(info.error, /inside the package/);
  }
  const dir = await makePackage({ schemaPath: "./linked.json", schemaDoc: null });
  await symlink(join(outside, "schema.json"), join(dir, "linked.json"));
  assert.match(describePluginSettings(dir).error, /inside the package/);
});

test("refuses settings files that are relative, outside home, traversing or not json", async () => {
  const cases = [
    ["config.json", /absolute path or start with ~\//],
    ["%APPDATA%/example/config.json", /absolute path or start with ~\//],
    ["$HOME/.example/config.json", /absolute path or start with ~\//],
    ["~/../escape.json", /must not contain \.\./],
    ["~/.example/../../escape.json", /must not contain \.\./],
    [join(outside, "config.json"), /inside your home folder/],
    ["/etc/passwd.json", /inside your home folder/],
    ["~/.example/config.yaml", /must end in \.json/],
  ];
  for (const [file, message] of cases) {
    const info = describePluginSettings(await makePackage({ file }));
    assert.equal(info.available, false, file);
    assert.match(info.error, message, file);
    assert.throws(() => expandSettingsFilePath(file), message, file);
  }
});

test("refuses a settings file that is a symlink out of home, and one through a linked folder", async () => {
  await writeFile(join(outside, "target.json"), "{}");
  await symlink(join(outside, "target.json"), join(home, "linked.json"));
  await symlink(outside, join(home, "linked-dir"));
  for (const file of ["~/linked.json", "~/linked-dir/new.json"]) {
    const pkg = await makePackage({ file });
    const info = describePluginSettings(pkg);
    assert.equal(info.available, false, file);
    assert.match(info.error, /outside your home folder/, file);
    assert.throws(() => writePluginSettings(pkg, { url: "http://x" }), /outside your home folder/, file);
  }
  assert.equal(await readFile(join(outside, "target.json"), "utf8"), "{}");
  assert.equal(existsSync(join(outside, "new.json")), false);
});

test("refuses a dangling symlink", async () => {
  await symlink(join(home, "nowhere.json"), join(home, "dangling.json"));
  const info = describePluginSettings(await makePackage({ file: "~/dangling.json" }));
  assert.equal(info.available, false);
  assert.match(info.error, /symbolic link to nothing/);
});

test("a symlink inside home is followed and stays a link", async () => {
  await mkdir(join(home, "dotfiles"), { recursive: true });
  await writeFile(join(home, "dotfiles", "real.json"), JSON.stringify({ url: "http://real" }));
  await symlink(join(home, "dotfiles", "real.json"), join(home, "inside.json"));
  const pkg = await makePackage({ file: "~/inside.json" });
  assert.equal(readPluginSettings(pkg).values.url, "http://real");
  writePluginSettings(pkg, { limit: 4 });
  assert.deepEqual(JSON.parse(await readFile(join(home, "dotfiles", "real.json"), "utf8")), { url: "http://real", limit: 4 });
  const { lstatSync } = await import("node:fs");
  assert.equal(lstatSync(join(home, "inside.json")).isSymbolicLink(), true);
});

test("a missing file reads as empty; the first save creates folder (700) and file (600)", async () => {
  const pkg = await makePackage();
  const before = readPluginSettings(pkg);
  assert.equal(before.exists, false);
  assert.deepEqual(before.values, { token: { __secret: true, set: false } });
  assert.equal(before.file, configPath);
  assert.deepEqual(before.schema.properties.map((field) => field.key), ["url", "token", "limit"]);

  const after = writePluginSettings(pkg, { url: "http://127.0.0.1:9088", token: "s3cret" });
  assert.equal(after.exists, true);
  assert.equal(JSON.stringify(after).includes("s3cret"), false);
  assert.deepEqual(after.values.token, { __secret: true, set: true });
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, ".example")).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { url: "http://127.0.0.1:9088", token: "s3cret" });
  assert.equal((await readFile(configPath, "utf8")).endsWith("}\n"), true);
  // The atomic writer leaves no temporary file behind.
  assert.deepEqual(readdirSync(join(home, ".example")), ["config.json"]);
});

test("a save keeps keys the schema does not name, keeps an absent password, and removes with null", async () => {
  const pkg = await makePackage();
  await writeFile(configPath, JSON.stringify({ url: "http://old", token: "keep", extra: { nested: [1, 2] }, limit: 3 }));
  await chmod(configPath, 0o644);

  writePluginSettings(pkg, { limit: 8 });
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
    url: "http://old", token: "keep", extra: { nested: [1, 2] }, limit: 8,
  });
  assert.equal(statSync(configPath).mode & 0o777, 0o600, "a looser mode is tightened");

  const cleared = writePluginSettings(pkg, { token: null, limit: null });
  assert.deepEqual(cleared.values.token, { __secret: true, set: false });
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { url: "http://old", extra: { nested: [1, 2] } });
});

test("a refused save writes nothing and reports each field", async () => {
  const pkg = await makePackage();
  const original = JSON.stringify({ url: "http://old" });
  await writeFile(configPath, original);
  let thrown;
  try {
    writePluginSettings(pkg, { limit: 0, stray: true, url: null });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof PluginSettingsValidationError);
  assert.equal(thrown.status, 422);
  assert.deepEqual(Object.fromEntries(Object.entries(thrown.fieldErrors).map(([k, v]) => [k, v.code])), {
    limit: "minimum", stray: "unknown", url: "required",
  });
  assert.equal(await readFile(configPath, "utf8"), original);
  assert.throws(() => writePluginSettings(pkg, [1]), PluginSettingsError);
});

test("an unreadable settings file is reported, never overwritten", async () => {
  const pkg = await makePackage();
  for (const content of ["{ not json", "[1,2]"]) {
    await writeFile(configPath, content);
    assert.throws(() => readPluginSettings(pkg), (error) => error.status === 422);
    assert.throws(() => writePluginSettings(pkg, { url: "http://x" }), (error) => error.status === 422);
    assert.equal(await readFile(configPath, "utf8"), content);
  }
});

test("refuses settings files in ~/.pi and ~/.ssh, lexically and through links", async () => {
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await mkdir(join(home, ".ssh"), { recursive: true });
  await writeFile(join(home, ".pi", "agent", "auth.json"), "{}");
  await mkdir(join(home, "dotfiles", "pi"), { recursive: true });
  await symlink(join(home, ".pi", "agent", "auth.json"), join(home, "innocent.json"));
  await symlink(join(home, ".ssh"), join(home, "ssh-link"));
  const cases = ["~/.pi/agent/auth.json", "~/.pi/new.json", "~/.ssh/config.json", join(home, ".pi", "x.json"),
    "~/innocent.json", "~/ssh-link/new.json"];
  for (const file of cases) {
    const pkg = await makePackage({ file });
    const info = describePluginSettings(pkg);
    assert.equal(info.available, false, file);
    assert.match(info.error, /protected directory/, file);
    assert.throws(() => writePluginSettings(pkg, { url: "http://x" }), (error) => error.status === 403 && /protected directory/.test(error.message), file);
  }
  assert.equal(await readFile(join(home, ".pi", "agent", "auth.json"), "utf8"), "{}");
  assert.equal(existsSync(join(home, ".pi", "new.json")), false);
  // A look-alike folder is fine.
  assert.equal(describePluginSettings(await makePackage({ file: "~/.pi-other/config.json" })).available, true);
});

test("refuses a real ~/.pi reached through a linked folder", async () => {
  await rm(join(home, ".pi"), { recursive: true, force: true });
  await mkdir(join(home, "dotfiles", "pi"), { recursive: true });
  await symlink(join(home, "dotfiles", "pi"), join(home, ".pi"));
  const info = describePluginSettings(await makePackage({ file: "~/.pi/agent.json" }));
  assert.equal(info.available, false);
  assert.match(info.error, /protected directory/);
});

test("a schema with an invalid pattern makes the settings unavailable", async () => {
  const info = describePluginSettings(await makePackage({
    schemaDoc: { properties: { a: { type: "string", pattern: "([" } } },
  }));
  assert.equal(info.available, false);
  assert.match(info.error, /pattern of a is not a valid regular expression/);
});

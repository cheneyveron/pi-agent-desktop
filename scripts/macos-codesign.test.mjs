import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findMachOFiles, isMachO, wantsDeveloperIdSigning } from "./macos-codesign.mjs";

const header = (...words) => Buffer.concat(words.map((word) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(word);
  return buffer;
}));

test("only a real identity on macOS asks for Developer ID signing", () => {
  assert.equal(wantsDeveloperIdSigning("Developer ID Application: Example (ABCDE12345)", "darwin"), true);
  assert.equal(wantsDeveloperIdSigning("-", "darwin"), false);
  assert.equal(wantsDeveloperIdSigning("", "darwin"), false);
  assert.equal(wantsDeveloperIdSigning(undefined, "darwin"), false);
  assert.equal(wantsDeveloperIdSigning("Developer ID Application: Example (ABCDE12345)", "linux"), false);
});

test("isMachO accepts thin and universal binaries but not Java classes or ELF", () => {
  assert.equal(isMachO(header(0xcffaedfe, 0x0c000001)), true); // arm64, little endian on disk
  assert.equal(isMachO(header(0xcefaedfe, 0x07000000)), true);
  assert.equal(isMachO(header(0xfeedfacf, 0x01000007)), true);
  assert.equal(isMachO(header(0xcafebabe, 2)), true); // universal, two slices
  assert.equal(isMachO(header(0xcafebabe, 0x00000034)), false); // Java 8 class file
  assert.equal(isMachO(header(0x7f454c46, 0x02010100)), false); // ELF
  assert.equal(isMachO(Buffer.from("MZ")), false);
});

test("findMachOFiles finds nested binaries deepest first and skips symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "macho-"));
  try {
    const prebuilds = join(dir, "node_modules", "node-pty", "prebuilds", "darwin-arm64");
    await mkdir(prebuilds, { recursive: true });
    await writeFile(join(prebuilds, "pty.node"), header(0xcffaedfe, 0x0c000001));
    await writeFile(join(prebuilds, "spawn-helper"), header(0xcafebabe, 2));
    await chmod(join(prebuilds, "spawn-helper"), 0o755);
    await writeFile(join(dir, "top"), header(0xcffaedfe, 0x0c000001));
    await writeFile(join(dir, "server.js"), "console.log(1)\n");
    await writeFile(join(dir, "Foo.class"), header(0xcafebabe, 0x34));
    await writeFile(join(dir, "empty"), "");
    await symlink(join(prebuilds, "pty.node"), join(dir, "link.node"));

    assert.deepEqual(await findMachOFiles(dir), [
      join(prebuilds, "pty.node"),
      join(prebuilds, "spawn-helper"),
      join(dir, "top"),
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

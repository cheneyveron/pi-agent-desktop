import assert from "node:assert/strict";
import test from "node:test";
import { getProjectDisplayName, getProjectDisplayNames } from "./project-display.ts";

test("keeps only the basename when project names are unique", () => {
  assert.equal(getProjectDisplayName("/work/pi-gui", ["/work/pi-gui", "/work/meetmemo"]), "pi-gui");
});

test("disambiguates duplicate project basenames with parent segments", () => {
  const projects = [
    "/Users/youcai/Common-File",
    "/Users/youcai/租车业务/Common-File",
    "/Users/youcai/AI/Common-File",
  ];
  assert.deepEqual(projects.map((path) => getProjectDisplayName(path, projects)), [
    "youcai/Common-File",
    "租车业务/Common-File",
    "AI/Common-File",
  ]);
});

test("keeps widening the suffix only while duplicates remain", () => {
  const projects = ["/a/team/app", "/b/team/app", "/c/other/app"];
  assert.deepEqual(projects.map((path) => getProjectDisplayName(path, projects)), [
    "a/team/app",
    "b/team/app",
    "other/app",
  ]);
});

test("normalizes Windows separators and trailing slashes", () => {
  assert.equal(
    getProjectDisplayName("C:\\work\\Pi\\", ["C:\\work\\Pi", "D:\\other\\Pi"]),
    "work/Pi",
  );
});

test("builds one resolved label per project path", () => {
  const names = getProjectDisplayNames(["/work/alpha", "/other/alpha"]);
  assert.deepEqual([...names.entries()], [
    ["/work/alpha", "work/alpha"],
    ["/other/alpha", "other/alpha"],
  ]);
});

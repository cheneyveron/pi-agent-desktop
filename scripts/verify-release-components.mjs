import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  compareVersions,
  createComponentManifest,
  isReleasePinValid,
  readLocalComponentVersions,
  readRemoteComponentVersions,
  rootDir,
} from "./release-components.mjs";

const local = await readLocalComponentVersions();
const remote = await readRemoteComponentVersions();
const pins = JSON.parse(await readFile(join(rootDir, "scripts", "release-component-pins.json"), "utf8"));
const problems = [];
if (
  compareVersions(local.pi, remote.pi.version) !== 0
  && !isReleasePinValid(pins.pi, local.pi)
) {
  problems.push(`pi is ${local.pi}; latest Release is ${remote.pi.version}`);
}
if (
  compareVersions(local["pi-web"], remote["pi-web"].version) !== 0
  && !isReleasePinValid(pins["pi-web"], local["pi-web"])
) {
  problems.push(`pi-web is ${local["pi-web"]}; latest Release is ${remote["pi-web"].version}`);
}
if (
  remote["pi-agent-desktop"]
  && compareVersions(local["pi-agent-desktop"], remote["pi-agent-desktop"].version) <= 0
) {
  // Equal is as wrong as older: the tag already exists, so the release job would fail
  // with `already_exists` after the whole matrix had built.
  problems.push(
    `pi-agent-desktop is ${local["pi-agent-desktop"]}; it must be newer than the latest Release ${remote["pi-agent-desktop"].version}`,
  );
}

const expectedManifest = createComponentManifest(local);
const actualManifest = JSON.parse(await readFile(
  join(rootDir, "src-tauri", "resources", "component-versions.json"),
  "utf8",
));
if (JSON.stringify(actualManifest) !== JSON.stringify(expectedManifest)) {
  problems.push("component-versions.json does not match the bundled package versions");
}

if (problems.length > 0) {
  throw new Error(`Release verification failed:\n- ${problems.join("\n- ")}`);
}
console.log(
  `Verified pi-agent-desktop ${local["pi-agent-desktop"]}, pi ${local.pi}${isReleasePinValid(pins.pi, local.pi) ? " (pinned)" : ""}, pi-web ${local["pi-web"]}${isReleasePinValid(pins["pi-web"], local["pi-web"]) ? " (pinned)" : ""}.`,
);

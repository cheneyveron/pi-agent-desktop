import assert from "node:assert/strict";
import test from "node:test";
import { detectUiPlatform } from "./ui-platform.ts";

test("desktop platforms map to their OS family", () => {
  assert.equal(detectUiPlatform({ platform: "MacIntel" }), "macos");
  assert.equal(detectUiPlatform({ platform: "Win32" }), "windows");
  assert.equal(detectUiPlatform({ platform: "Linux x86_64" }), "linux");
});

test("phones, tablets and unknown platforms get no platform styling", () => {
  assert.equal(detectUiPlatform({ platform: "Linux armv8l", userAgent: "Mozilla/5.0 (Linux; Android 14)" }), null);
  assert.equal(detectUiPlatform({ platform: "iPhone" }), null);
  // iPadOS reports a Mac platform; its user agent still names the device when it asks for mobile pages.
  assert.equal(detectUiPlatform({ platform: "MacIntel", userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)" }), null);
  assert.equal(detectUiPlatform({ platform: "" }), null);
  assert.equal(detectUiPlatform(undefined), null);
});

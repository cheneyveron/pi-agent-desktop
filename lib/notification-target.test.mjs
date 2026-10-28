import { test } from "node:test";
import assert from "node:assert/strict";
import { createNotificationTargetStore } from "./notification-target.ts";

test("the latest notification's session is opened once", () => {
  const store = createNotificationTargetStore(1000);
  store.set("a", 0);
  store.set("b", 10);
  assert.equal(store.take(20), "b");
  assert.equal(store.take(30), null);
});

test("a notification without a session clears the target", () => {
  const store = createNotificationTargetStore(1000);
  store.set("a", 0);
  store.set(null, 10);
  assert.equal(store.take(20), null);
});

test("an expired target is dropped", () => {
  const store = createNotificationTargetStore(1000);
  store.set("a", 0);
  assert.equal(store.take(1001), null);
});

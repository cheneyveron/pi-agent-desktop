import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname.replace(/\/$/, "") } });
const a = await jiti.import("./main-session-arrival.ts");

const task = (extra = {}) => ({
  id: "CAS-1", aliases: [], title: "根因修复", status: "need", stands: "已定位", sessions: ["s-b"], open: [], log: [], waits: [], artifacts: [],
  next: [{ text: "跑单测", run: "agent" }, { text: "已做的", run: "me", done: true }, { text: "二", run: "me" }, { text: "三", run: "me" }, { text: "四", run: "me" }],
  createdAt: "x", updatedAt: "x", ...extra,
});

test("the card carries the question, the answers and up to three pending steps", () => {
  const card = a.arrivalOf(task({ ask: { eventId: "e1", short: "推还是等", text: "推还是等？", why: "", chips: ["推", "等"], act: "ask", at: "x" } }), "s-b", "CAS-1", "背景包");
  assert.deepEqual(
    { question: card.question, stands: card.stands, next: card.next, chips: card.chips, eventId: card.eventId, context: card.context },
    { question: "推还是等？", stands: undefined, next: ["跑单测", "二", "三"], chips: ["推", "等"], eventId: "e1", context: "背景包" },
  );
  // Nothing asked: it says where the task stands instead.
  assert.equal(a.arrivalOf(task(), "s-b", "CAS-1").stands, "已定位");
});

test("the card belongs to one session and goes when another session is opened after it was shown", () => {
  a.setTaskArrival(a.arrivalOf(task(), "s-b", "CAS-1"));
  // The session that was on screen before the jump does not end it.
  a.sessionShown("s-a");
  assert.equal(a.getTaskArrival().sessionId, "s-b");
  a.sessionShown("s-b");
  a.sessionShown("s-b");
  assert.equal(a.getTaskArrival().sessionId, "s-b");
  a.sessionShown("s-c");
  assert.equal(a.getTaskArrival(), null);
});

test("sending or closing drops only that session's card", () => {
  a.setTaskArrival(a.arrivalOf(task(), "s-b", "CAS-1"));
  a.clearTaskArrival("s-other");
  assert.ok(a.getTaskArrival());
  a.clearTaskArrival("s-b");
  assert.equal(a.getTaskArrival(), null);
});

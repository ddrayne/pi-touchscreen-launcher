import assert from "node:assert/strict";
import test from "node:test";

import { watchWake } from "../lib/wake.ts";

class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
  emit(type, data) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
  close() {
    this.closed = true;
  }
}

function fakeFetch(statusByCall) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body });
    const status = statusByCall.shift() ?? { pending: false, sequence: 0 };
    return new Response(JSON.stringify(status), { status: 200 });
  };
  return { calls, fetchFn };
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a wake pushed over the event stream starts one conversation and is acknowledged", async () => {
  FakeEventSource.instances = [];
  const { calls, fetchFn } = fakeFetch([]);
  const woke = [];
  const stop = watchWake({
    onWake: (sequence) => woke.push(sequence),
    fetch: fetchFn,
    EventSource: FakeEventSource,
    pollMs: 60_000,
  });
  const source = FakeEventSource.instances[0];
  assert.equal(source.url, "/api/wake/events");

  source.emit("wake", { pending: true, sequence: 7 });
  source.emit("wake", { pending: true, sequence: 7 });
  source.emit("wake", { pending: false, sequence: 7 });
  await tick(5);

  assert.deepEqual(woke, [7]);
  const acks = calls.filter((call) => call.method === "POST");
  assert.equal(acks.length, 1);
  assert.deepEqual(JSON.parse(acks[0].body), { action: "ack", sequence: 7 });

  stop();
  assert.equal(source.closed, true);
});

test("the fallback poll catches a wake the stream missed and never replays an old one", async () => {
  FakeEventSource.instances = [];
  const { calls, fetchFn } = fakeFetch([
    { pending: true, sequence: 3 },
    { pending: true, sequence: 3 },
    { pending: false, sequence: 3 },
  ]);
  const woke = [];
  const stop = watchWake({
    onWake: (sequence) => woke.push(sequence),
    fetch: fetchFn,
    EventSource: FakeEventSource,
    pollMs: 10,
  });
  await tick(60);
  stop();

  assert.deepEqual(woke, [3]);
  const polls = calls.filter((call) => call.method === "GET");
  assert.ok(polls.length >= 3, `expected the poll to keep running, saw ${polls.length}`);
  assert.ok(polls.every((call) => call.url === "/api/wake"));
});

test("without EventSource the poll runs on its own at a wake-friendly cadence", async () => {
  const { calls, fetchFn } = fakeFetch([]);
  const stop = watchWake({
    onWake: () => {},
    fetch: fetchFn,
    EventSource: undefined,
    pollMs: 10,
  });
  await tick(45);
  stop();
  assert.ok(calls.length >= 3);
});

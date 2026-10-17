import assert from "node:assert/strict";
import test from "node:test";

import { discardBody, HttpError, readJson, settle } from "../lib/http.ts";

function responseWithCancelSpy(status, text = "{}") {
  const spy = { cancelled: false };
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
    cancel() {
      spy.cancelled = true;
    },
  });
  return { response: new Response(stream, { status }), spy };
}

test("readJson parses an OK body", async () => {
  const { response } = responseWithCancelSpy(200, '{"ok":true}');
  assert.deepEqual(await readJson(response, "unavailable"), { ok: true });
});

test("readJson cancels the body of an error response before throwing", async () => {
  // Every unread fetch body pins a 2 MB Chromium data pipe (and a file
  // descriptor) until the next full garbage collection. A page that polls
  // a failing endpoint every 20 s leaks hundreds of them.
  const { response, spy } = responseWithCancelSpy(502, '{"error":"down"}');
  await assert.rejects(readJson(response, "Household hub unavailable"), (error) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 502);
    assert.equal(error.message, "Household hub unavailable");
    return true;
  });
  assert.equal(spy.cancelled, true);
});

test("discardBody cancels an unread body and tolerates a consumed one", async () => {
  const { response, spy } = responseWithCancelSpy(200);
  await discardBody(response);
  assert.equal(spy.cancelled, true);

  const consumed = new Response("{}", { status: 200 });
  await consumed.json();
  await discardBody(consumed);
  await discardBody(null);
  await discardBody(undefined);
});

test("settle drains a fire-and-forget request and swallows failures", async () => {
  const { response, spy } = responseWithCancelSpy(200);
  await settle(Promise.resolve(response));
  assert.equal(spy.cancelled, true);
  await settle(Promise.reject(new Error("offline")));
});

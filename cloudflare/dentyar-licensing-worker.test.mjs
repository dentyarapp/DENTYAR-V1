import test from "node:test";
import assert from "node:assert/strict";
import { RedemptionLock } from "./dentyar-licensing-worker.js";

function makeState() {
  const values = new Map();
  let tail = Promise.resolve();
  return {
    storage: {
      async get(key) { return values.get(key); },
      async put(key, value) { values.set(key, value); },
      transaction(fn) {
        const run = tail.then(() => fn({
          get: async key => values.get(key),
          put: async (key, value) => values.set(key, value)
        }));
        tail = run.catch(() => {});
        return run;
      }
    }
  };
}

test("a redemption code can be claimed only once, including concurrent requests", async () => {
  const lock = new RedemptionLock(makeState());
  const claims = await Promise.all([
    lock.fetch(new Request("https://redemption-lock/claim", { method: "POST" })),
    lock.fetch(new Request("https://redemption-lock/claim", { method: "POST" }))
  ]);
  assert.deepEqual(claims.map(response => response.status).sort(), [200, 409]);
});

test("a previously claimed redemption code stays unavailable", async () => {
  const lock = new RedemptionLock(makeState());
  const first = await lock.fetch(new Request("https://redemption-lock/claim", { method: "POST" }));
  const second = await lock.fetch(new Request("https://redemption-lock/claim", { method: "POST" }));
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
});

test("only POST /claim is accepted", async () => {
  const lock = new RedemptionLock(makeState());
  const response = await lock.fetch(new Request("https://redemption-lock/other", { method: "POST" }));
  assert.equal(response.status, 404);
});

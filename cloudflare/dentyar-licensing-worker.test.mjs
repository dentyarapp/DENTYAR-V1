import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const workerSource = await readFile(new URL("./dentyar-licensing-worker.js", import.meta.url), "utf8");
const { RedemptionLock, ActivationRateLimiter } = await import("data:text/javascript;base64," + Buffer.from(workerSource).toString("base64"));

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

const workerModule = await import("data:text/javascript;base64," + Buffer.from(workerSource).toString("base64"));
const worker = workerModule.default;

function testEnv() {
  const values = new Map();
  const lockStates = new Map();
  const stateFor = name => { if(!lockStates.has(name)) lockStates.set(name,makeState()); return lockStates.get(name); };
  return {
    LICENSES: {
      async get(key, type) {
        const value = values.get(key);
        if (type === "json" && typeof value === "string") return JSON.parse(value);
        return value;
      },
      async put(key, value) { values.set(key, value); },
      async delete(key) { values.delete(key); },
      async list({prefix}) { return {keys:[...values.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name}))}; }
    },
    REDEMPTION_LOCKS: {
      idFromName(name) { return name; },
      get(name) { return {fetch: request => new RedemptionLock(stateFor(name)).fetch(request)}; }
    },
    ACTIVATION_LIMITS: {
      idFromName(name) { return name; },
      get() { return {fetch: async () => new Response("allowed",{status:200})}; }
    },
    _values: values
  };
}

test("health endpoint is public and returns service identity", async () => {
  const response = await worker.fetch(new Request("https://license.test/health"), testEnv());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).service, "dentyar-licensing");
});

test("activation request rejects malformed clinic and device identifiers", async () => {
  const response = await worker.fetch(new Request("https://license.test/v1/activation/request", {
    method:"POST", headers:{"content-type":"application/json"},
    body:JSON.stringify({clinicCode:"x",deviceId:"short",deviceName:"Test"})
  }), testEnv());
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid-request");
});

test("activation request stores a pending request without requiring owner credentials", async () => {
  const env = testEnv();
  const response = await worker.fetch(new Request("https://license.test/v1/activation/request", {
    method:"POST", headers:{"content-type":"application/json"},
    body:JSON.stringify({clinicCode:"CLINIC_01",deviceId:"device_identifier_123",deviceName:"Test phone",appVersion:"101"})
  }), env);
  const data = await response.json();
  assert.equal(response.status, 202);
  assert.equal(data.status, "pending");
  assert.ok(data.requestId);
  assert.equal(env._values.get("request:"+data.requestId) !== undefined, true);
});

test("oversized activation requests are rejected before parsing", async () => {
  const response = await worker.fetch(new Request("https://license.test/v1/activation/request", {
    method:"POST", headers:{"content-type":"application/json","content-length":"20000"}, body:"{}"
  }), testEnv());
  assert.equal(response.status, 413);
});

test("owner endpoints reject requests without a verified owner token", async () => {
  const response = await worker.fetch(new Request("https://license.test/v1/owner/requests", {
    method:"POST", headers:{"content-type":"application/json"}, body:"{}"
  }), testEnv());
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "owner-auth-required");
});

test("unknown POST endpoints do not expose internal routing details", async () => {
  const response = await worker.fetch(new Request("https://license.test/v1/not-a-route", {
    method:"POST", headers:{"content-type":"application/json"}, body:"{}"
  }), testEnv());
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "owner-auth-required");
});

test("CORS preflight advertises only the API methods and required headers", async () => {
  const response = await worker.fetch(new Request("https://license.test/v1/activation/request", {method:"OPTIONS"}), testEnv());
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-methods"), "GET,POST,OPTIONS");
  assert.equal(response.headers.get("access-control-allow-headers"), "authorization,content-type");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("owner approval rejects non-integer or out-of-range expiry before creating a license", async () => {
  const env = testEnv();
  const requestId = "a".repeat(32);
  env._values.set("request:"+requestId, JSON.stringify({
    id:requestId, clinicCode:"CLINIC_01", deviceId:"device_identifier_123",
    deviceName:"Test phone", status:"pending", createdAt:Date.now()
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    users:[{email:"owner@example.test",emailVerified:true}]
  }), {status:200,headers:{"content-type":"application/json"}});
  try {
    for (const expiryDays of ["not-a-number", 0, 3651, 1.5]) {
      const response = await worker.fetch(new Request("https://license.test/v1/owner/approve", {
        method:"POST",
        headers:{"content-type":"application/json","authorization":"Bearer test-id-token"},
        body:JSON.stringify({requestId,expiryDays})
      }), {...env, OWNER_EMAIL:"owner@example.test", FIREBASE_WEB_API_KEY:"test-api-key"});
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "invalid-expiry-days");
    }
    assert.equal([...env._values.keys()].filter(key=>key.startsWith("license:")).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("activation rate limiter allows five requests and blocks the sixth", async () => {
  const limiter = new ActivationRateLimiter(makeState());
  const responses = [];
  for (let i=0;i<6;i++) {
    responses.push(await limiter.fetch(new Request("https://activation-limit/check",{method:"POST"})));
  }
  assert.deepEqual(responses.map(response=>response.status),[200,200,200,200,200,429]);
});

test("activation rate limiter rejects unsupported methods and paths", async () => {
  const limiter = new ActivationRateLimiter(makeState());
  const response = await limiter.fetch(new Request("https://activation-limit/other",{method:"GET"}));
  assert.equal(response.status,404);
});

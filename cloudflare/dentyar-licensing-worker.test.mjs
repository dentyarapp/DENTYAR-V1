import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Script } from "node:vm";
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
      async delete(key) { values.delete(key); },
      async setAlarm(timestamp) { values.set("__alarm",timestamp); },
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

test("concurrent claims from different devices allow exactly one device", async () => {
  const lock = new RedemptionLock(makeState());
  const claim = deviceId => lock.fetch(new Request("https://redemption-lock/claim", {
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({deviceId})
  }));
  const claims = await Promise.all([claim("device_identifier_123"),claim("device_identifier_456")]);
  assert.deepEqual(claims.map(response => response.status).sort(), [200,409]);
});

test("the bound device can safely retry redemption without opening access to another device", async () => {
  const lock = new RedemptionLock(makeState());
  const claim = deviceId => lock.fetch(new Request("https://redemption-lock/claim", {
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({deviceId})
  }));
  assert.equal((await claim("device_identifier_123")).status,200);
  assert.equal((await claim("device_identifier_123")).status,200);
  assert.equal((await claim("device_identifier_456")).status,409);
});

test("concurrent owner approvals reuse one license ID and one activation code", async () => {
  const lock=new RedemptionLock(makeState());
  const approve=(licenseId,activationCode)=>lock.fetch(new Request("https://redemption-lock/approve",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({licenseId,activationCode,expiryDays:licenseId.startsWith("a")?30:365})
  }));
  const results=await Promise.all([
    approve("a".repeat(32),"A".repeat(16)),
    approve("b".repeat(32),"B".repeat(16))
  ]);
  assert.deepEqual(results.map(response=>response.status),[200,200]);
  const records=await Promise.all(results.map(response=>response.json()));
  assert.equal(records[0].licenseId,records[1].licenseId);
  assert.equal(records[0].activationCode,records[1].activationCode);
  assert.equal(records[0].expiryDays,records[1].expiryDays);
  assert.equal(records[0].licenseExpiresAt,records[1].licenseExpiresAt);
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
    method:"POST", headers:{"content-type":"application/json"}, body:" ".repeat(16385)
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

test("unexpected storage failures return a safe service-unavailable response", async () => {
  const env = testEnv();
  env.LICENSES.put = async () => { throw new Error("private-storage-detail"); };
  const response = await worker.fetch(new Request("https://license.test/v1/activation/request", {
    method:"POST", headers:{"content-type":"application/json"},
    body:JSON.stringify({clinicCode:"CLINIC_01",deviceId:"device_identifier_123",deviceName:"Test phone"})
  }), env);
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{ok:false,error:"service-unavailable"});
});

test("custom-token signing produces a Firebase-compatible three-part JWT", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {modulusLength:2048});
  const privatePem = privateKey.export({type:"pkcs8",format:"pem"}).toString();
  const token = await workerModule.makeCustomToken({
    FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify({
      client_email:"firebase-adminsdk@example.test",
      private_key:privatePem,
      project_id:"demo-dentyar"
    })
  }, {
    id:"license-test-001",
    clinicCode:"CLINIC_01",
    deviceId:"device_identifier_123"
  });
  assert.match(token,/^[^.]+\.[^.]+\.[^.]+$/);
  const payload = JSON.parse(Buffer.from(token.split(".")[1],"base64url").toString("utf8"));
  assert.equal(payload.uid,"dy_license-test-001");
  assert.equal(payload.licenseId,"license-test-001");
  assert.equal(payload.role,"clinic-device");
});

test("owner panel is served from the configured static asset binding", async () => {
  const env=testEnv();
  env.ASSETS={fetch:async request=>new Response(new URL(request.url).pathname,{status:200})};
  const response=await worker.fetch(new Request("https://license.test/owner"),env);
  assert.equal(response.status,200);
  assert.equal(await response.text(),"/owner.html");
});

test("owner login receives only the public Firebase client configuration", async () => {
  const env=testEnv();
  env.FIREBASE_WEB_API_KEY="public-client-key";
  env.FIREBASE_PROJECT_ID="demo-dentyar";
  const response=await worker.fetch(new Request("https://license.test/v1/owner/config"),env);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true,apiKey:"public-client-key",projectId:"demo-dentyar"});
});

test("owner panel contains syntactically valid JavaScript and Persian RTL layout", async () => {
  const html=await readFile(new URL("./licensing-panel/owner.html",import.meta.url),"utf8");
  assert.match(html,/<html lang="fa" dir="rtl">/);
  const match=html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match,"owner panel script exists");
  assert.doesNotThrow(()=>new Script(match[1]));
  assert.match(html,/accounts:signInWithPassword/);
  assert.match(html,/v1\/owner\/approve/);
});

test("isolated V101 app licensing integration script parses", async () => {
  const html=await readFile(new URL("../DENTYAR_V101_LICENSE_TRIAL.html",import.meta.url),"utf8");
  const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
  const target=scripts.find(script=>script.includes("LICENSE_API_URL"));
  assert.ok(target,"licensing integration script exists");
  assert.doesNotThrow(()=>new Script(target));
  assert.match(target,/signInWithCustomToken/);
  assert.match(target,/v1\/activation\/redeem/);
});

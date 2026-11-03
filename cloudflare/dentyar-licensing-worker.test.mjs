import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify as verifySignature } from "node:crypto";
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
        const run = tail.then(() => fn());
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
      get(name) { return {fetch: (input,init) => new RedemptionLock(stateFor(name)).fetch(input instanceof Request?input:new Request(input,init))}; }
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
  assert.equal(data.emailNotified,false);
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
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {modulusLength:2048});
  const privatePem = privateKey.export({type:"pkcs8",format:"pem"}).toString();
  const token = await workerModule.makeCustomToken({
    FIREBASE_PROJECT_ID:"dentyar-458d9",
    FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify({
      client_email:"firebase-adminsdk@example.test",
      private_key:privatePem,
      project_id:"dentyar-458d9"
    })
  }, {
    id:"license-test-001",
    clinicCode:"CLINIC_01",
    deviceId:"device_identifier_123"
  });
  assert.match(token,/^[^.]+\.[^.]+\.[^.]+$/);
  const [headerPart,payloadPart,signaturePart]=token.split(".");
  assert.equal(verifySignature("RSA-SHA256",Buffer.from(headerPart+"."+payloadPart),publicKey,Buffer.from(signaturePart,"base64url")),true);
  const header=JSON.parse(Buffer.from(headerPart,"base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(payloadPart,"base64url").toString("utf8"));
  assert.equal(header.alg,"RS256");
  assert.equal(payload.aud,"https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit");
  assert.equal(payload.uid,"dy_license-test-001");
  assert.deepEqual(payload.claims,{
    clinicCode:"CLINIC_01",
    deviceId:"device_identifier_123",
    licenseId:"license-test-001",
    role:"clinic-device"
  });
  assert.equal(payload.licenseId,undefined);
  assert.equal(payload.role,undefined);
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
  assert.deepEqual(await response.json(),{ok:true,apiKey:"public-client-key",projectId:"demo-dentyar",emailNotificationsEnabled:false});
  const configured=await worker.fetch(new Request("https://license.test/v1/owner/config"),{
    ...env,RESEND_API_KEY:"configured-resend-key",RESEND_FROM:"DENTYAR <licenses@example.test>"
  });
  assert.equal((await configured.json()).emailNotificationsEnabled,true);
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
  assert.match(target,/crypto\.getRandomValues/);
  assert.match(target,/dev_\[A-Fa-f0-9\]\{48\}/);
  assert.match(target,/getIdTokenResult\(true\)/);
  assert.match(target,/claims\.role!==['"]clinic-device['"]/);
  assert.doesNotMatch(target,/signInWithEmailAndPassword/);
});

test("owner approval API is idempotent when two owner sessions approve together", async () => {
  const env=testEnv();
  const requestId="c".repeat(32);
  const ownerEmail="owner@example.test";
  const {privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
  env.OWNER_EMAIL=ownerEmail;
  env.FIREBASE_WEB_API_KEY="test-public-key";
  env.FIREBASE_PROJECT_ID="dentyar-458d9";
  env.FIREBASE_DATABASE_URL="https://dentyar-458d9-default-rtdb.firebaseio.com";
  env.FIREBASE_SERVICE_ACCOUNT_JSON=JSON.stringify({
    client_email:"firebase-adminsdk@example.test",
    private_key:privateKey.export({type:"pkcs8",format:"pem"}).toString(),
    project_id:"dentyar-458d9"
  });
  env._values.set("request:"+requestId,JSON.stringify({
    id:requestId,clinicCode:"CLINIC_01",deviceId:"device_identifier_123",
    deviceName:"Test phone",status:"pending",createdAt:Date.now()
  }));
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async input=>{
    const url=String(input);
    if(url.includes("identitytoolkit.googleapis.com")) return new Response(JSON.stringify({
      users:[{email:ownerEmail,emailVerified:true}]
    }),{status:200,headers:{"content-type":"application/json"}});
    if(url.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({
      access_token:"test-admin-access-token",expires_in:3600
    }),{status:200,headers:{"content-type":"application/json"}});
    return new Response("null",{status:200});
  };
  try {
    const approve=expiryDays=>worker.fetch(new Request("https://license.test/v1/owner/approve",{
      method:"POST",headers:{"content-type":"application/json","authorization":"Bearer owner-id-token"},
      body:JSON.stringify({requestId,expiryDays})
    }),env);
    const responses=await Promise.all([approve(30),approve(365)]);
    assert.deepEqual(responses.map(response=>response.status),[200,200],JSON.stringify(await Promise.all(responses.map(response=>response.clone().json()))));
    const results=await Promise.all(responses.map(response=>response.json()));
    assert.equal(results[0].licenseId,results[1].licenseId);
    assert.equal(results[0].activationCode,results[1].activationCode);
    assert.equal(results[0].expiresAt,results[1].expiresAt);
    const request=JSON.parse(env._values.get("request:"+requestId));
    assert.equal(request.status,"approved");
    assert.equal(request.licenseId,results[0].licenseId);
    assert.ok(env._values.has("license:"+results[0].licenseId));
  } finally {
    globalThis.fetch=originalFetch;
  }
});

test("license revocation retries safely and persists database denial before KV status", async () => {
  const env=testEnv();
  const ownerEmail="owner@example.test";
  const licenseId="license-revoke-test";
  const license={id:licenseId,clinicCode:"CLINIC_01",deviceId:"device_identifier_123",status:"active",expiresAt:Date.now()+86400000};
  env._values.set("license:"+licenseId,JSON.stringify(license));
  env.OWNER_EMAIL=ownerEmail;
  env.FIREBASE_WEB_API_KEY="test-public-key";
  env.FIREBASE_PROJECT_ID="dentyar-458d9";
  env.FIREBASE_DATABASE_URL="https://dentyar-458d9-default-rtdb.firebaseio.com";
  env.FIREBASE_SERVICE_ACCOUNT_JSON=JSON.stringify({client_email:"firebase-adminsdk@example.test",private_key:"unused",project_id:"dentyar-458d9"});
  const sequence=[];
  let failDatabaseWrite=true;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async input=>{
    const url=String(input);
    if(url.includes("identitytoolkit.googleapis.com")) return new Response(JSON.stringify({users:[{email:ownerEmail,emailVerified:true}]}),{status:200});
    if(url.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({access_token:"test-admin-access-token",expires_in:3600}),{status:200});
    sequence.push("database");
    if(failDatabaseWrite){failDatabaseWrite=false;return new Response("temporary failure",{status:500});}
    return new Response("null",{status:200});
  };
  const originalPut=env.LICENSES.put;
  env.LICENSES.put=async(key,value,options)=>{if(key==="license:"+licenseId)sequence.push("kv");return originalPut(key,value,options);};
  try {
    const revoke=()=>worker.fetch(new Request("https://license.test/v1/owner/revoke",{
      method:"POST",headers:{"content-type":"application/json","authorization":"Bearer owner-id-token"},
      body:JSON.stringify({licenseId})
    }),env);
    const first=await revoke();
    assert.equal(first.status,503,JSON.stringify(await first.clone().json()));
    assert.equal(JSON.parse(env._values.get("license:"+licenseId)).status,"active");
    const second=await revoke();
    assert.equal(second.status,200,JSON.stringify(await second.clone().json()));
    assert.equal(JSON.parse(env._values.get("license:"+licenseId)).status,"revoked");
    assert.deepEqual(sequence,["database","database","kv"]);
  } finally {
    globalThis.fetch=originalFetch;
  }
});

test("admin database writes are pinned to the canonical DENTYAR RTDB host", () => {
  const base=workerModule.databaseBase({
    FIREBASE_PROJECT_ID:"dentyar-458d9",
    FIREBASE_DATABASE_URL:"https://dentyar-458d9-default-rtdb.firebaseio.com/"
  });
  assert.equal(base,"https://dentyar-458d9-default-rtdb.firebaseio.com");
  for(const FIREBASE_DATABASE_URL of [
    "http://dentyar-458d9-default-rtdb.firebaseio.com",
    "https://dentyar-458d9-default-rtdb.europe-west1.firebasedatabase.app",
    "https://other-project-default-rtdb.firebaseio.com",
    "https://dentyar-458d9-default-rtdb.firebaseio.com/other",
    "https://dentyar-458d9-default-rtdb.firebaseio.com?x=1",
    "https://dentyar-458d9-default-rtdb.firebaseio.com:444"
  ]) {
    assert.throws(()=>workerModule.databaseBase({FIREBASE_PROJECT_ID:"dentyar-458d9",FIREBASE_DATABASE_URL}));
  }
});

test("owner can recover an issued activation code after a lost approval response", async () => {
  const env=testEnv();
  const requestId="a".repeat(32);
  const licenseId="b".repeat(32);
  const activationCode="A1B2C3D4E5F60718";
  const approvalLock=env.REDEMPTION_LOCKS.get("approval:"+requestId);
  const approval=await approvalLock.fetch("https://redemption-lock/approve",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({licenseId,activationCode,expiryDays:365})
  });
  assert.equal(approval.status,200);
  env._values.set("license:"+licenseId,JSON.stringify({
    id:licenseId,clinicCode:"CLINIC_01",deviceId:"device_identifier_123",
    deviceName:"Test phone",status:"active",requestId
  }));
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({
    users:[{email:"owner@example.test",emailVerified:true}]
  }),{status:200,headers:{"content-type":"application/json"}});
  try {
    const response=await worker.fetch(new Request("https://license.test/v1/owner/activation-code",{
      method:"POST",headers:{"content-type":"application/json","authorization":"Bearer owner-id-token"},
      body:JSON.stringify({licenseId})
    }),{...env,OWNER_EMAIL:"owner@example.test",FIREBASE_WEB_API_KEY:"test-api-key"});
    assert.equal(response.status,200);
    const data=await response.json();
    assert.equal(data.activationCode,activationCode);
    assert.equal(data.licenseId,licenseId);
  } finally {
    globalThis.fetch=originalFetch;
  }
});

test("redemption lock exposes no approval details after expiry", async () => {
  const lock=new RedemptionLock(makeState());
  const response=await lock.fetch(new Request("https://redemption-lock/approval"));
  assert.equal(response.status,404);
});

test("activation redemption supports same-device retries and blocks cross-device replay", async () => {
  const env=testEnv();
  const code="A1B2C3D4E5F60718";
  const licenseId="c".repeat(32);
  const deviceId="device_identifier_123";
  const clinicCode="CLINIC_01";
  const {privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
  env.FIREBASE_PROJECT_ID="dentyar-458d9";
  env.FIREBASE_SERVICE_ACCOUNT_JSON=JSON.stringify({
    client_email:"firebase-adminsdk@example.test",
    private_key:privateKey.export({type:"pkcs8",format:"pem"}).toString(),
    project_id:"dentyar-458d9"
  });
  const codeHash=await workerModule.digest(code);
  env._values.set("code:"+codeHash,licenseId);
  env._values.set("license:"+licenseId,JSON.stringify({
    id:licenseId,clinicCode,deviceId,status:"active",expiresAt:Date.now()+86400000
  }));
  const makeRequest=()=>new Request("https://license.test/v1/activation/redeem",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({code,clinicCode,deviceId})
  });
  const responses=await Promise.all([worker.fetch(makeRequest(),env),worker.fetch(makeRequest(),env)]);
  assert.deepEqual(responses.map(response=>response.status).sort(),[200,200],JSON.stringify(await Promise.all(responses.map(response=>response.clone().json()))));
  const results=await Promise.all(responses.map(response=>response.json()));
  for(const data of results){
    assert.equal(data.ok,true);
    assert.equal(data.licenseId,licenseId);
    assert.match(data.customToken,/^[^.]+\.[^.]+\.[^.]+$/);
    const tokenClaims=JSON.parse(Buffer.from(data.customToken.split(".")[1],"base64url").toString("utf8")).claims;
    assert.deepEqual(tokenClaims,{clinicCode,deviceId,licenseId,role:"clinic-device"});
  }
  const saved=JSON.parse(env._values.get("license:"+licenseId));
  assert.ok(saved.redeemedAt);
  const wrongDevice=await worker.fetch(new Request("https://license.test/v1/activation/redeem",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({code,clinicCode,deviceId:"another_device_identifier"})
  }),env);
  assert.equal(wrongDevice.status,403);
  const retry=await worker.fetch(makeRequest(),env);
  assert.equal(retry.status,200);
});

test("activation redemption enforces per-IP attempt limits before checking codes", async () => {
  const env=testEnv();
  env.ACTIVATION_LIMITS.get=()=>({fetch:async()=>new Response("rate-limited",{status:429})});
  const response=await worker.fetch(new Request("https://license.test/v1/activation/redeem",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"203.0.113.9"},
    body:JSON.stringify({code:"A1B2C3D4E5F60718",clinicCode:"CLINIC_01",deviceId:"device_identifier_123"})
  }),env);
  assert.equal(response.status,429);
  assert.equal((await response.json()).error,"activation-attempt-rate-limited");
});

test("activation request reports email notification only after Resend accepts it", async () => {
  const env=testEnv();
  env.RESEND_API_KEY="test-resend-key";
  env.RESEND_FROM="DENTYAR <licenses@example.test>";
  env.OWNER_EMAIL="owner@example.test";
  const originalFetch=globalThis.fetch;
  let captured=null;
  globalThis.fetch=async (input,init)=>{
    captured={url:String(input),headers:init.headers,body:JSON.parse(init.body)};
    return new Response(JSON.stringify({id:"email-test-001"}),{status:200,headers:{"content-type":"application/json"}});
  };
  try{
    const response=await worker.fetch(new Request("https://license.test/v1/activation/request",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({clinicCode:"CLINIC_01",deviceId:"device_identifier_123",deviceName:"Test phone",appVersion:"101"})
    }),env);
    const result=await response.json();
    assert.equal(response.status,202);
    assert.equal(result.emailNotified,true);
    assert.equal(captured.url,"https://api.resend.com/emails");
    assert.equal(captured.body.to[0],"owner@example.test");
    assert.match(captured.body.text,/CLINIC_01/);
  }finally{globalThis.fetch=originalFetch;}
});

test("Resend rejection is reported as no notification without losing activation request", async () => {
  const env=testEnv();
  env.RESEND_API_KEY="test-resend-key";
  env.RESEND_FROM="DENTYAR <licenses@example.test>";
  env.OWNER_EMAIL="owner@example.test";
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response("rejected",{status:403});
  try{
    const response=await worker.fetch(new Request("https://license.test/v1/activation/request",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({clinicCode:"CLINIC_01",deviceId:"device_identifier_456",deviceName:"Test tablet",appVersion:"101"})
    }),env);
    const result=await response.json();
    assert.equal(response.status,202);
    assert.equal(result.emailNotified,false);
    assert.equal([...env._values.keys()].filter(key=>key.startsWith("request:")).length,1);
  }finally{globalThis.fetch=originalFetch;}
});

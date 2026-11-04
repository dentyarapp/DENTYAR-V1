/**
 * DENTYAR licensing API — separate Worker; does not replace the existing sync relay.
 *
 * Required bindings:
 *   KV namespace: LICENSES
 *   Durable Objects: REDEMPTION_LOCKS (RedemptionLock), ACTIVATION_LIMITS (ActivationRateLimiter)
 * Required secrets:
 *   FIREBASE_SERVICE_ACCOUNT_JSON (service-account JSON; never commit)
 *   RESEND_API_KEY (optional; required for owner email notifications)
 *
 * Variables:
 *   OWNER_EMAIL = primary verified Firebase owner email
 *   OWNER_EMAILS = comma-separated verified owner email allowlist (primary + backup)
 *   FIREBASE_PROJECT_ID = dentyar-458d9
 *   FIREBASE_DATABASE_URL = https://dentyar-458d9-default-rtdb.firebaseio.com
 *   RESEND_FROM = verified sender, e.g. DENTYAR <licenses@your-verified-domain>
 */
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "vary": "Origin", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const encoder = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
const json = (data, status=200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const fail = (code, status=400) => json({ ok:false, error:code }, status);
const now = () => Date.now();
async function readJsonLimited(request, maxBytes=16384) {
  const reader=request.body && request.body.getReader();
  if(!reader) throw new Error("invalid-json");
  const chunks=[];
  let total=0;
  while(true) {
    const {done,value}=await reader.read();
    if(done) break;
    total+=value.byteLength;
    if(total>maxBytes) {
      try { await reader.cancel(); } catch {}
      const error=new Error("request-too-large");
      error.code="request-too-large";
      throw error;
    }
    chunks.push(value);
  }
  const bytes=new Uint8Array(total);
  let offset=0;
  for(const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
const randomHex = (n=24) => [...crypto.getRandomValues(new Uint8Array(n))].map(x=>x.toString(16).padStart(2,"0")).join("");
const ACTIVATION_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function randomActivationCode() {
  let code = "";
  while (code.length < 16) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    for (const byte of bytes) {
      if (byte < 252) code += ACTIVATION_ALPHABET[byte % ACTIVATION_ALPHABET.length];
      if (code.length === 16) break;
    }
  }
  return code;
}
const isActivationCode = value => /^[A-Z0-9]{16}$/.test(String(value));
async function digest(value) {
  return b64url(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
async function signJwt(payload, privateKeyPem) {
  const pem = privateKeyPem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,"");
  const binary = Uint8Array.from(atob(pem), c=>c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", binary, { name:"RSASSA-PKCS1-v1_5", hash:"SHA-256" }, false, ["sign"]);
  const head = b64url(encoder.encode(JSON.stringify({ alg:"RS256", typ:"JWT" })));
  const body = b64url(encoder.encode(JSON.stringify(payload)));
  const input = head+"."+body;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(input));
  return input+"."+b64url(signature);
}
let cachedAccess = null;
function ownerEmails(env) {
  const values=[env.OWNER_EMAIL, ...(String(env.OWNER_EMAILS||"").split(","))]
    .map(value=>String(value||"").trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(values)];
}
function databaseBase(env) {
  const projectId=String(env.FIREBASE_PROJECT_ID||"");
  const configured=String(env.FIREBASE_DATABASE_URL||"");
  if(!/^[a-z0-9-]{4,40}$/.test(projectId)) throw new Error("firebase-project-id-invalid");
  const url=new URL(configured);
  if(url.protocol!=="https:" || url.hostname!==projectId+"-default-rtdb.firebaseio.com" || url.username || url.password || url.port || url.search || url.hash || (url.pathname!=="/" && url.pathname!=="")) {
    throw new Error("firebase-database-url-mismatch");
  }
  return url.origin;
}
async function googleAccess(env) {
  if (cachedAccess && cachedAccess.exp > now()+60000) return cachedAccess.token;
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
  if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error("firebase-admin-secret-not-configured");
  if (sa.project_id !== String(env.FIREBASE_PROJECT_ID||"")) throw new Error("firebase-service-account-project-mismatch");
  const iat = Math.floor(now()/1000);
  const assertion = await signJwt({ iss:sa.client_email, scope:"https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email", aud:"https://oauth2.googleapis.com/token", iat, exp:iat+3600 }, sa.private_key);
  const response = await fetch("https://oauth2.googleapis.com/token", { method:"POST", headers:{ "content-type":"application/x-www-form-urlencoded" }, body:new URLSearchParams({ grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error("google-admin-token-failed");
  cachedAccess = { token:data.access_token, exp:now()+Number(data.expires_in||3600)*1000 };
  return data.access_token;
}
async function dbWrite(env, path, value) {
  const token = await googleAccess(env);
  const base = databaseBase(env);
  const url = base+"/"+path.replace(/^\//,"")+".json";
  const response = await fetch(url, { method:"PUT", headers:{ authorization:"Bearer "+token, "content-type":"application/json" }, body:JSON.stringify(value) });
  if (!response.ok) throw new Error("firebase-admin-db-write-failed");
}
async function verifyOwner(request, env) {
  const auth = request.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const apiKey = String(env.FIREBASE_WEB_API_KEY || "");
  if (!apiKey) return false;
  const response = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key="+encodeURIComponent(apiKey), {
    method:"POST", headers:{ "content-type":"application/json" },
    body:JSON.stringify({ idToken:match[1] })
  });
  if (!response.ok) return false;
  const data = await response.json();
  const user = data.users && data.users[0];
  return !!(user && user.emailVerified && !user.disabled && ownerEmails(env).includes(String(user.email||"").trim().toLowerCase()));
}
async function sendOwnerEmail(env, subject, body) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) return false;
  const response = await fetch("https://api.resend.com/emails", {
    method:"POST",
    headers:{ authorization:"Bearer "+env.RESEND_API_KEY, "content-type":"application/json" },
    body:JSON.stringify({ from:env.RESEND_FROM, to:ownerEmails(env), subject, text:body })
  });
  return response.ok;
}
async function makeCustomToken(env, license) {
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
  if(sa.project_id !== String(env.FIREBASE_PROJECT_ID||"")) throw new Error("firebase-service-account-project-mismatch");
  const iat = Math.floor(now()/1000);
  return signJwt({
    iss:sa.client_email, sub:sa.client_email,
    aud:"https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
    iat, exp:iat+3600,
    uid:"dy_"+license.id.slice(0,24),
    claims:{
      clinicCode:license.clinicCode,
      deviceId:license.deviceId,
      licenseId:license.id,
      role:"clinic-device"
    }
  }, sa.private_key);
}
async function redeem(request, env, body) {
  const clientIp=request.headers.get("cf-connecting-ip") || "unknown";
  const limiterId=env.ACTIVATION_LIMITS.idFromName("redeem:"+clientIp);
  const limiter=env.ACTIVATION_LIMITS.get(limiterId);
  const rate=await limiter.fetch("https://activation-limit/check",{method:"POST"});
  if (!rate.ok) return fail("activation-attempt-rate-limited",429);
  const normalizedCode = String(body.code||"").trim().toUpperCase();
  if (!isActivationCode(normalizedCode)) return fail("invalid-or-used-code",401);
  if (!/^[A-Za-z0-9_-]{12,100}$/.test(String(body.deviceId||"")) || !/^[A-Z0-9_-]{4,32}$/.test(String(body.clinicCode||""))) return fail("invalid-request");
  const codeHash = await digest(normalizedCode);
  const id = await env.LICENSES.get("code:"+codeHash);
  if (!id) return fail("invalid-or-used-code", 401);
  const license = await env.LICENSES.get("license:"+id, "json");
  if (!license || license.status!=="active" || license.deviceId!==body.deviceId || license.clinicCode!==body.clinicCode) return fail("license-not-active-for-this-device", 403);
  if (license.expiresAt && license.expiresAt<now()) return fail("license-expired", 403);
  // Prepare the token before the irreversible one-time claim. A signing/configuration
  // failure must not consume an otherwise valid activation code.
  let customToken;
  try { customToken = await makeCustomToken(env,license); }
  catch (error) { console.error("Custom token preparation failed",error); return fail("activation-temporarily-unavailable",503); }
  const lockId = env.REDEMPTION_LOCKS.idFromName(codeHash);
  const lock = env.REDEMPTION_LOCKS.get(lockId);
  const claim = await lock.fetch("https://redemption-lock/claim", {
    method:"POST", headers:{"content-type":"application/json"},
    body:JSON.stringify({deviceId:license.deviceId})
  });
  if (!claim.ok) return fail("invalid-or-used-code",401);
  license.redeemedAt = now();
  await env.LICENSES.put("license:"+id, JSON.stringify(license));
  // Keep the short-lived code digest until its seven-day TTL. The Durable Object
  // permits retries only from the already-bound device, so a lost HTTP response
  // cannot strand that device after its first successful claim.
  return json({ ok:true, customToken, licenseId:id, expiresAt:license.expiresAt||null });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
    if (request.method==="OPTIONS") return new Response(null,{status:204,headers:{ ...JSON_HEADERS, "access-control-allow-methods":"GET,POST,OPTIONS", "access-control-allow-headers":"authorization,content-type", "access-control-max-age":"600" }});
    if (url.pathname==="/health" && request.method==="GET") return json({ ok:true, service:"dentyar-licensing", version:1 });
    if (request.method==="GET" && (url.pathname==="/owner" || url.pathname==="/owner/")) {
      if (!env.ASSETS) return fail("owner-panel-not-configured",503);
      const asset=await env.ASSETS.fetch(new Request(new URL("/owner.html",request.url),request));
      const headers=new Headers(asset.headers);
      headers.set("x-frame-options","DENY");
      headers.set("x-content-type-options","nosniff");
      headers.set("referrer-policy","no-referrer");
      headers.set("cache-control","no-store");
      return new Response(asset.body,{status:asset.status,statusText:asset.statusText,headers});
    }
    if (url.pathname==="/v1/owner/config" && request.method==="GET") {
      return json({ ok:true, apiKey:String(env.FIREBASE_WEB_API_KEY||""), projectId:String(env.FIREBASE_PROJECT_ID||""), emailNotificationsEnabled:!!(env.RESEND_API_KEY && env.RESEND_FROM) });
    }
    if (request.method!=="POST") return fail("method-not-allowed",405);
    let body;
    try { body=await readJsonLimited(request,16384); }
    catch (error) { return error && error.code==="request-too-large" ? fail("request-too-large",413) : fail("invalid-json"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail("invalid-request-body");
    if (url.pathname==="/v1/activation/request") {
      const clinicCode=String(body.clinicCode||"").trim().toUpperCase();
      const deviceId=String(body.deviceId||"").trim();
      const deviceName=String(body.deviceName||"").trim().slice(0,80);
      if (!/^[A-Z0-9_-]{4,32}$/.test(clinicCode) || !/^[A-Za-z0-9_-]{12,100}$/.test(deviceId) || !deviceName) return fail("invalid-request");
      const clinicRecord=await env.LICENSES.get("clinic:"+clinicCode,"json");
      if(!clinicRecord || clinicRecord.status!=="active") return fail("clinic-not-registered",409);
      const clientIp=request.headers.get("cf-connecting-ip") || "unknown";
      const limiterId=env.ACTIVATION_LIMITS.idFromName("activation:"+clientIp);
      const limiter=env.ACTIVATION_LIMITS.get(limiterId);
      const rate=await limiter.fetch("https://activation-limit/check",{method:"POST"});
      if (!rate.ok) return fail("activation-request-rate-limited",429);
      const requestId=randomHex(16);
      const item={ id:requestId, clinicCode, deviceId, deviceName, appVersion:String(body.appVersion||"").slice(0,40), status:"pending", createdAt:now() };
      await env.LICENSES.put("request:"+requestId,JSON.stringify(item),{expirationTtl:60*60*24*30});
      await env.LICENSES.put("request-index:"+requestId,requestId,{expirationTtl:60*60*24*30});
      let emailNotified=false;
      try { emailNotified=await sendOwnerEmail(env,"درخواست فعال‌سازی دنت‌یار", "درخواست جدید دستگاه دنت‌یار\nمطب: "+clinicCode+"\nدستگاه: "+deviceName+"\nشناسه درخواست: "+requestId+"\nبرای بررسی، پنل مالک را باز کنید."); } catch (emailError) { console.error("Owner notification failed",emailError); }
      return json({ ok:true, requestId, status:"pending", emailNotified },202);
    }
    if (url.pathname==="/v1/activation/redeem") return redeem(request,env,body);
    if (!await verifyOwner(request,env)) return fail("owner-auth-required",403);
    if (url.pathname==="/v1/owner/clinics/list") {
      const clinics=[];
      let cursor=null;
      do {
        const page=await env.LICENSES.list({prefix:"clinic:",limit:1000,...(cursor?{cursor}:{})});
        for(const key of page.keys){const item=await env.LICENSES.get(key.name,"json");if(item)clinics.push(item);}
        cursor=page.list_complete===false?page.cursor:null;
        if(page.list_complete===false&&!cursor) throw new Error("clinic-directory-pagination-cursor-missing");
      } while(cursor);
      clinics.sort((a,b)=>a.createdAt-b.createdAt);
      return json({ok:true,clinics});
    }
    if (url.pathname==="/v1/owner/clinics/register") {
      const clinicCode=String(body.clinicCode||"").trim().toUpperCase();
      const clinicName=String(body.clinicName||"").trim().slice(0,120);
      if(!/^[A-Z0-9_-]{4,32}$/.test(clinicCode) || clinicName.length<2) return fail("invalid-clinic-details");
      if(await env.LICENSES.get("clinic:"+clinicCode)) return fail("clinic-code-already-registered",409);
      const registryId=env.CLINIC_REGISTRY.idFromName("clinic:"+clinicCode);
      const registry=env.CLINIC_REGISTRY.get(registryId);
      const claim=await registry.fetch("https://clinic-registry/register",{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({clinicCode,clinicName})
      });
      if(!claim.ok) return fail(claim.status===409?"clinic-code-already-registered":"clinic-registry-unavailable",claim.status===409?409:503);
      const clinic={clinicCode,clinicName,status:"active",createdAt:now()};
      await env.LICENSES.put("clinic:"+clinicCode,JSON.stringify(clinic));
      return json({ok:true,clinic},201);
    }
    if (url.pathname==="/v1/owner/requests") {
      const keys=await env.LICENSES.list({prefix:"request:"});
      const requests=[];
      for (const key of keys.keys) {
        const item=await env.LICENSES.get(key.name,"json");
        if (item && item.status==="pending") requests.push(item);
      }
      requests.sort((a,b)=>a.createdAt-b.createdAt);
      return json({ ok:true, requests });
    }
    if (url.pathname==="/v1/owner/reject") {
      const item=await env.LICENSES.get("request:"+String(body.requestId||""),"json");
      if (!item || item.status!=="pending") return fail("request-not-pending",404);
      const lock=env.REDEMPTION_LOCKS.get(env.REDEMPTION_LOCKS.idFromName("approval:"+item.id));
      const decision=await lock.fetch("https://redemption-lock/reject",{method:"POST"});
      if(!decision.ok) return fail("request-already-approved",409);
      item.status="rejected"; item.reviewedAt=now();
      await env.LICENSES.put("request:"+item.id,JSON.stringify(item));
      return json({ ok:true, status:"rejected" });
    }
    if (url.pathname==="/v1/owner/approve") {
      const item=await env.LICENSES.get("request:"+String(body.requestId||""),"json");
      if (!item || item.status!=="pending") return fail("request-not-pending",404);
      const requestedExpiry = body.expiryDays === undefined ? 365 : Number(body.expiryDays);
      if (!Number.isInteger(requestedExpiry) || requestedExpiry < 1 || requestedExpiry > 3650) return fail("invalid-expiry-days",400);
      // Claim an idempotent approval record before external writes. Parallel clicks and
      // retries reuse the same license ID and activation code instead of minting duplicates.
      const approvalLockId=env.REDEMPTION_LOCKS.idFromName("approval:"+item.id);
      const approvalLock=env.REDEMPTION_LOCKS.get(approvalLockId);
      const proposed={licenseId:randomHex(16),activationCode:randomActivationCode(),expiryDays:requestedExpiry};
      const approvalResponse=await approvalLock.fetch("https://redemption-lock/approve",{
        method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(proposed)
      });
      if(!approvalResponse.ok) {
        const lockError=await approvalResponse.text();
        console.error("Owner approval lock rejected",approvalResponse.status,lockError);
        return approvalResponse.status===409 ? fail("request-already-rejected",409) : fail("approval-lock-failed",503);
      }
      const approval=await approvalResponse.json();
      const id=approval.licenseId, code=approval.activationCode, expiryDays=approval.expiryDays;
      const license={ id, clinicCode:item.clinicCode, deviceId:item.deviceId, deviceName:item.deviceName, status:"active", createdAt:now(), expiresAt:approval.licenseExpiresAt, requestId:item.id };
      await dbWrite(env,"licenses/"+id,{ status:"active", clinicCode:item.clinicCode, deviceId:item.deviceId, expiresAt:license.expiresAt });
      await env.LICENSES.put("license:"+id,JSON.stringify(license));
      await env.LICENSES.put("code:"+await digest(code),id,{expirationTtl:60*60*24*7});
      item.status="approved"; item.licenseId=id; item.reviewedAt=now();
      await env.LICENSES.put("request:"+item.id,JSON.stringify(item));
      return json({ ok:true, licenseId:id, activationCode:code, deviceName:item.deviceName, clinicCode:item.clinicCode });
    }
    if (url.pathname==="/v1/owner/revoke") {
      const license=await env.LICENSES.get("license:"+String(body.licenseId||""),"json");
      if (!license) return fail("license-not-found",404);
      license.status="revoked"; license.revokedAt=now();
      // RTDB is the authorization source checked by security rules. Revoke there first;
      // if KV persistence fails, the owner can safely retry this idempotent operation.
      await dbWrite(env,"licenses/"+license.id,{ status:"revoked", clinicCode:license.clinicCode, deviceId:license.deviceId, revokedAt:license.revokedAt });
      await env.LICENSES.put("license:"+license.id,JSON.stringify(license));
      return json({ ok:true, status:"revoked" });
    }
    if (url.pathname==="/v1/owner/activation-code") {
      const license=await env.LICENSES.get("license:"+String(body.licenseId||""),"json");
      if (!license || !license.requestId) return fail("license-not-found",404);
      if(license.status!=="active" || (license.expiresAt && license.expiresAt<=now())) return fail("license-not-active",403);
      const approvalId=env.REDEMPTION_LOCKS.idFromName("approval:"+license.requestId);
      const approvalLock=env.REDEMPTION_LOCKS.get(approvalId);
      let approvalResponse=await approvalLock.fetch("https://redemption-lock/approval",{method:"GET"});
      let reissued=false;
      if(!approvalResponse.ok) {
        const activationCode=randomActivationCode();
        const remainingDays=Math.max(1,Math.min(3650,Math.ceil((license.expiresAt-now())/(24*60*60*1000))));
        approvalResponse=await approvalLock.fetch("https://redemption-lock/approve",{
          method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify({licenseId:license.id,activationCode,expiryDays:remainingDays})
        });
        if(!approvalResponse.ok) return fail("activation-code-reissue-failed",409);
        reissued=true;
      }
      const approval=await approvalResponse.json();
      if (approval.licenseId!==license.id || !approval.activationCode) return fail("activation-code-expired-or-unavailable",404);
      if(reissued) await env.LICENSES.put("code:"+await digest(approval.activationCode),license.id,{expirationTtl:60*60*24*7});
      return json({ok:true,licenseId:license.id,activationCode:approval.activationCode,clinicCode:license.clinicCode,deviceName:license.deviceName,reissued});
    }
    if (url.pathname==="/v1/owner/licenses") {
      const keys=await env.LICENSES.list({prefix:"license:"});
      const licenses=[];
      for (const key of keys.keys) { const item=await env.LICENSES.get(key.name,"json"); if(item) licenses.push(item); }
      return json({ ok:true, licenses });
    }
    return fail("not-found",404);
    } catch (error) {
      console.error("Licensing API request failed", error);
      return fail("service-unavailable",503);
    }
  }
};


// Durable Object provides an atomic, per-code one-time redemption claim.
export class RedemptionLock {
  constructor(state) { this.state = state; }
  async fetch(request) {
    const path=new URL(request.url).pathname;
    if(request.method==="GET" && path==="/approval") {
      const approval=await this.state.storage.get("approval");
      if(!approval || approval.rejected || !approval.activationCode || approval.expiresAt<=now()) return new Response("not-found",{status:404});
      return new Response(JSON.stringify(approval),{status:200,headers:{"content-type":"application/json"}});
    }
    if(request.method!=="POST") return new Response("not-found",{status:404});
    if(path!=="/approve" && path!=="/reject" && path!=="/claim") return new Response("not-found",{status:404});
    let body={};
    if(path!=="/reject") {
      try { body=await request.json(); } catch { return new Response("invalid-request",{status:400}); }
    }
    if(path==="/reject") {
      const result=await this.state.storage.transaction(async txn=>{
        const existing=await txn.get("approval");
        if(existing && existing.licenseId) return "already-approved";
        if(existing && existing.rejected) return "rejected";
        await txn.put("approval",{rejected:true,rejectedAt:now()});
        return "rejected";
      });
      return new Response(result,{status:result==="already-approved"?409:200});
    }
    if(path==="/approve") {
      const licenseId=String(body.licenseId||"");
      const activationCode=String(body.activationCode||"");
      const expiryDays=Number(body.expiryDays);
      if(!/^[a-f0-9]{32}$/.test(licenseId) || !isActivationCode(activationCode) || !Number.isInteger(expiryDays) || expiryDays<1 || expiryDays>3650) return new Response("invalid-approval",{status:400});
      const approval=await this.state.storage.transaction(async txn=>{
        const existing=await txn.get("approval");
        if(existing && existing.rejected) return {rejected:true};
        if(existing && existing.licenseId) {
          if(existing.activationCode && existing.expiresAt>now()) return existing;
          const renewed={...existing,activationCode,expiresAt:now()+7*24*60*60*1000,expiredAt:null};
          await txn.put("approval",renewed);
          return renewed;
        }
        const next={licenseId,activationCode,expiryDays,licenseExpiresAt:now()+expiryDays*24*60*60*1000,expiresAt:now()+7*24*60*60*1000};
        await txn.put("approval",next);
        return next;
      });
      if(approval.rejected) return new Response("already-rejected",{status:409});
      await this.state.storage.setAlarm(approval.expiresAt);
      return new Response(JSON.stringify(approval),{status:200,headers:{"content-type":"application/json"}});
    }
    const deviceId=String(body.deviceId||"");
    if(!/^[A-Za-z0-9_-]{12,100}$/.test(deviceId)) return new Response("invalid-device",{status:400});
    const claimed=await this.state.storage.transaction(async txn=>{
      const existing=await txn.get("claim");
      if(existing) return existing.deviceId===deviceId;
      await txn.put("claim",{deviceId,claimedAt:now()});
      return true;
    });
    return new Response(claimed?"claimed":"already-used",{status:claimed?200:409});
  }
  async alarm() {
    const nextExpiry=await this.state.storage.transaction(async txn=>{
      const approval=await txn.get("approval");
      if(!approval || !approval.activationCode) return null;
      if(approval.expiresAt<=now()) {
        await txn.put("approval",{...approval,activationCode:null,expiredAt:now(),expiresAt:0});
        return null;
      }
      return approval.expiresAt;
    });
    if(nextExpiry) await this.state.storage.setAlarm(nextExpiry);
  }
}


// Atomic one-time claim for each clinic code. A code can never be assigned to two clinics.
export class ClinicRegistry {
  constructor(state) { this.state=state; }
  async fetch(request) {
    if(request.method!=="POST" || new URL(request.url).pathname!=="/register") return new Response("not-found",{status:404});
    let body={};try{body=await request.json();}catch{return new Response("invalid-request",{status:400});}
    const clinicCode=String(body.clinicCode||"").trim().toUpperCase();
    const clinicName=String(body.clinicName||"").trim().slice(0,120);
    if(!/^[A-Z0-9_-]{4,32}$/.test(clinicCode) || clinicName.length<2) return new Response("invalid-clinic",{status:400});
    const result=await this.state.storage.transaction(async txn=>{
      const existing=await txn.get("clinic");
      if(existing) return existing.clinicName===clinicName ? "same" : "exists";
      await txn.put("clinic",{clinicCode,clinicName,createdAt:now()});
      return "created";
    });
    return new Response(result,{status:result==="exists"?409:200});
  }
}

// Per-IP activation request limiter: five requests per rolling minute window.
export class ActivationRateLimiter {
  constructor(state) { this.state=state; }
  async fetch(request) {
    if(request.method!=="POST" || new URL(request.url).pathname!=="/check") return new Response("not-found",{status:404});
    const allowed=await this.state.storage.transaction(async txn=>{
      const timestamp=now();
      const current=await txn.get("window");
      const window=current && timestamp-current.startedAt<60000 ? current : {startedAt:timestamp,count:0};
      if(window.count>=5) return false;
      window.count+=1;
      await txn.put("window",window);
      return true;
    });
    return new Response(allowed?"allowed":"rate-limited",{status:allowed?200:429});
  }
}

export { makeCustomToken, databaseBase, digest, randomActivationCode, isActivationCode };

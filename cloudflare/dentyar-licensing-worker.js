/**
 * DENTYAR licensing API — separate Worker; does not replace the existing sync relay.
 *
 * Required bindings:
 *   KV namespace: LICENSES
 * Required secrets:
 *   FIREBASE_SERVICE_ACCOUNT_JSON (service-account JSON; never commit)
 *   RESEND_API_KEY (optional until email notifications are enabled)
 *
 * Variables:
 *   OWNER_EMAIL = verified Firebase owner email
 *   FIREBASE_PROJECT_ID = dentyar-458d9
 *   FIREBASE_DATABASE_URL = https://dentyar-458d9-default-rtdb.firebaseio.com
 *   RESEND_FROM = verified sender, e.g. DENTYAR <licenses@your-verified-domain>
 */
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const encoder = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
const json = (data, status=200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const fail = (code, status=400) => json({ ok:false, error:code }, status);
const now = () => Date.now();
const randomHex = (n=24) => [...crypto.getRandomValues(new Uint8Array(n))].map(x=>x.toString(16).padStart(2,"0")).join("");
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
async function googleAccess(env) {
  if (cachedAccess && cachedAccess.exp > now()+60000) return cachedAccess.token;
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
  if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error("firebase-admin-secret-not-configured");
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
  const base = (env.FIREBASE_DATABASE_URL || "").replace(/\/$/,"");
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
  return !!(user && user.emailVerified && String(user.email).toLowerCase()===String(env.OWNER_EMAIL).toLowerCase());
}
async function sendOwnerEmail(env, subject, body) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) return;
  await fetch("https://api.resend.com/emails", {
    method:"POST",
    headers:{ authorization:"Bearer "+env.RESEND_API_KEY, "content-type":"application/json" },
    body:JSON.stringify({ from:env.RESEND_FROM, to:[env.OWNER_EMAIL], subject, text:body })
  });
}
async function makeCustomToken(env, license) {
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
  const iat = Math.floor(now()/1000);
  return signJwt({
    iss:sa.client_email, sub:sa.client_email,
    aud:"https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
    iat, exp:iat+3600,
    uid:"dy_"+license.id.slice(0,24),
    clinicCode:license.clinicCode, deviceId:license.deviceId, licenseId:license.id, role:"clinic-device"
  }, sa.private_key);
}
async function redeem(env, body) {
  const codeHash = await digest(String(body.code||"").trim().toUpperCase());
  const id = await env.LICENSES.get("code:"+codeHash);
  if (!id) return fail("invalid-or-used-code", 401);
  const license = await env.LICENSES.get("license:"+id, "json");
  if (!license || license.status!=="active" || license.deviceId!==body.deviceId || license.clinicCode!==body.clinicCode) return fail("license-not-active-for-this-device", 403);
  if (license.expiresAt && license.expiresAt<now()) return fail("license-expired", 403);
  const customToken = await makeCustomToken(env,license);
  license.redeemedAt = now();
  await env.LICENSES.put("license:"+id, JSON.stringify(license));
  await env.LICENSES.delete("code:"+codeHash);
  return json({ ok:true, customToken, licenseId:id, expiresAt:license.expiresAt||null });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method==="OPTIONS") return new Response(null,{status:204,headers:{ "access-control-allow-origin":"*", "access-control-allow-methods":"GET,POST,OPTIONS", "access-control-allow-headers":"authorization,content-type" }});
    if (url.pathname==="/health" && request.method==="GET") return json({ ok:true, service:"dentyar-licensing", version:1 });
    if (request.method!=="POST") return fail("method-not-allowed",405);
    let body; try { body=await request.json(); } catch { return fail("invalid-json"); }
    if (url.pathname==="/v1/activation/request") {
      const clinicCode=String(body.clinicCode||"").trim().toUpperCase();
      const deviceId=String(body.deviceId||"").trim();
      const deviceName=String(body.deviceName||"").trim().slice(0,80);
      if (!/^[A-Z0-9_-]{4,32}$/.test(clinicCode) || !/^[A-Za-z0-9_-]{12,100}$/.test(deviceId) || !deviceName) return fail("invalid-request");
      const requestId=randomHex(16);
      const item={ id:requestId, clinicCode, deviceId, deviceName, appVersion:String(body.appVersion||"").slice(0,40), status:"pending", createdAt:now() };
      await env.LICENSES.put("request:"+requestId,JSON.stringify(item),{expirationTtl:60*60*24*30});
      await env.LICENSES.put("request-index:"+requestId,requestId,{expirationTtl:60*60*24*30});
      await sendOwnerEmail(env,"درخواست فعال‌سازی دنت‌یار", "درخواست جدید دستگاه دنت‌یار\nمطب: "+clinicCode+"\nدستگاه: "+deviceName+"\nشناسه درخواست: "+requestId+"\nبرای بررسی، پنل مالک را باز کنید.");
      return json({ ok:true, requestId, status:"pending" },202);
    }
    if (url.pathname==="/v1/activation/redeem") return redeem(env,body);
    if (!await verifyOwner(request,env)) return fail("owner-auth-required",403);
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
      item.status="rejected"; item.reviewedAt=now();
      await env.LICENSES.put("request:"+item.id,JSON.stringify(item));
      return json({ ok:true, status:"rejected" });
    }
    if (url.pathname==="/v1/owner/approve") {
      const item=await env.LICENSES.get("request:"+String(body.requestId||""),"json");
      if (!item || item.status!=="pending") return fail("request-not-pending",404);
      const id=randomHex(16), code=randomHex(8).toUpperCase();
      const expiryDays = Math.min(3650, Math.max(1, Number(body.expiryDays || 365)));
      const license={ id, clinicCode:item.clinicCode, deviceId:item.deviceId, deviceName:item.deviceName, status:"active", createdAt:now(), expiresAt:now()+expiryDays*24*60*60*1000, requestId:item.id };
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
      await env.LICENSES.put("license:"+license.id,JSON.stringify(license));
      await dbWrite(env,"licenses/"+license.id,{ status:"revoked", clinicCode:license.clinicCode, deviceId:license.deviceId, revokedAt:license.revokedAt });
      return json({ ok:true, status:"revoked" });
    }
    if (url.pathname==="/v1/owner/licenses") {
      const keys=await env.LICENSES.list({prefix:"license:"});
      const licenses=[];
      for (const key of keys.keys) { const item=await env.LICENSES.get(key.name,"json"); if(item) licenses.push(item); }
      return json({ ok:true, licenses });
    }
    return fail("not-found",404);
  }
};

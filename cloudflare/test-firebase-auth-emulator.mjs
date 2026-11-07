import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { makeCustomToken } from "./dentyar-licensing-worker.js";

const projectId="demo-dentyar";
const {privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const privatePem=privateKey.export({type:"pkcs8",format:"pem"}).toString();
const license={id:"emulator-license-001",clinicCode:"CLINIC_01",deviceId:"device_identifier_123"};
const token=await makeCustomToken({
  FIREBASE_PROJECT_ID:projectId,
  FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify({
    client_email:"firebase-adminsdk@demo-dentyar.iam.gserviceaccount.com",
    private_key:privatePem,
    project_id:projectId
  })
},license);
const response=await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key",{
  method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({token,returnSecureToken:true})
});
const result=await response.json();
assert.equal(response.status,200,JSON.stringify(result));
assert.ok(result.idToken,"Firebase Auth emulator must exchange the custom token for an ID token");
const idClaims=JSON.parse(Buffer.from(result.idToken.split(".")[1],"base64url").toString("utf8"));
console.log("Auth emulator identity claims:",JSON.stringify({localId:result.localId,sub:idClaims.sub,user_id:idClaims.user_id,role:idClaims.role,claims:idClaims}));
assert.equal(idClaims.sub||idClaims.user_id,"dy_emulator-license-001");
const idTokenClaims=JSON.parse(Buffer.from(result.idToken.split(".")[1],"base64url").toString("utf8"));
assert.equal(idTokenClaims.sub,"dy_emulator-license-001");
assert.equal(idTokenClaims.role,"clinic-device");
assert.equal(idTokenClaims.licenseId,license.id);
assert.equal(idTokenClaims.clinicCode,license.clinicCode);
assert.equal(idTokenClaims.deviceId,license.deviceId);
console.log("Firebase Auth emulator: custom token exchanged and custom claims propagated successfully.");

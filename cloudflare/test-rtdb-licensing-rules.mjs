import assert from "node:assert/strict";

const base="http://127.0.0.1:9000";
const namespace="demo-dentyar-default-rtdb";
const licenseId="lic_test_001";
const clinicCode="CLINIC_01";
const deviceId="device_identifier_123";
const adminHeaders={authorization:"Bearer owner","content-type":"application/json"};

function url(path,auth){
  const target=new URL(path+".json",base);
  target.searchParams.set("ns",namespace);
  if(auth) target.searchParams.set("auth_variable_override",JSON.stringify(auth));
  return target;
}
async function adminPut(path,value){
  const response=await fetch(url(path),{method:"PUT",headers:adminHeaders,body:JSON.stringify(value)});
  assert.ok(response.ok,"emulator admin seed failed: "+path+" "+response.status+" "+await response.text());
}
async function request(path,auth,method="GET",value){
  return fetch(url(path,auth),{
    method,
    headers:{"content-type":"application/json"},
    ...(value===undefined?{}:{body:JSON.stringify(value)})
  });
}
function token(overrides={}){
  return {uid:"dy_test_device",token:{role:"clinic-device",clinicCode,deviceId,licenseId,...overrides}};
}
async function expectAllowed(response,label){
  assert.ok(response.ok,label+" should be allowed, got "+response.status+" "+await response.text());
}
async function expectDenied(response,label){
  assert.ok(response.status===401||response.status===403,label+" should be denied, got "+response.status+" "+await response.text());
}

await adminPut("licenses/"+licenseId,{
  status:"active",clinicCode,deviceId,expiresAt:Date.now()+86400000
});
await adminPut("clinics/"+clinicCode+"/records/meta",{clinicName:"Test Clinic"});
await adminPut("clinics/"+clinicCode+"/records/patients/p1",{id:"p1",name:"Patient Test"});

await expectAllowed(await request("clinics/"+clinicCode+"/records/meta",token()),"licensed clinic read");
await expectAllowed(await request("clinics/"+clinicCode+"/records/meta",token(), "PUT",{clinicName:"Updated"}),"licensed clinic write");
await expectAllowed(await request("licenses/"+licenseId,token()),"matching license metadata read");
await expectDenied(await request("licenses/"+licenseId,token({licenseId:"another_license"})),"other license metadata read");
await expectDenied(await request("clinics/"+clinicCode+"/records/meta",null),"unauthenticated clinic read");
await expectDenied(await request("clinics/"+clinicCode+"/records/meta",token({clinicCode:"OTHER_01"})),"cross-clinic read");
await expectDenied(await request("clinics/"+clinicCode+"/records/meta",token({deviceId:"other_device_123"})),"wrong-device read");
await expectDenied(await request("licenses/"+licenseId,token(),"PUT",{status:"revoked"}),"client license metadata write");

await adminPut("licenses/"+licenseId,{status:"revoked",clinicCode,deviceId,revokedAt:Date.now()});
await expectDenied(await request("clinics/"+clinicCode+"/records/meta",token()),"revoked license access");

await adminPut("licenses/"+licenseId,{status:"active",clinicCode,deviceId,expiresAt:Date.now()-1000});
await expectDenied(await request("clinics/"+clinicCode+"/records/meta",token()),"expired license access");

console.log("Firebase RTDB licensing rules: all emulator checks passed.");

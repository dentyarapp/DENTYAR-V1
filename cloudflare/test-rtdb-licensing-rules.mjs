import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { ref, get, set } from "firebase/database";

const projectId="demo-dentyar";
const licenseId="lic_test_001";
const clinicCode="CLINIC_01";
const deviceId="device_identifier_123";
const rules=await readFile(new URL("../firebase-database.rules.template.json",import.meta.url),"utf8");
const env=await initializeTestEnvironment({
  projectId,
  database:{host:"127.0.0.1",port:9000,rules}
});

try {
  await env.withSecurityRulesDisabled(async context=>{
    const db=context.database();
    await set(ref(db,"licenses/"+licenseId),{
      status:"active",clinicCode,deviceId,expiresAt:Date.now()+86400000
    });
    await set(ref(db,"clinics/"+clinicCode+"/records/meta"),{clinicName:"Test Clinic"});
    await set(ref(db,"clinics/"+clinicCode+"/records/patients/p1"),{id:"p1",name:"Patient Test"});
  });

  const licensed=env.authenticatedContext("dy_test_device",{
    role:"clinic-device",clinicCode,deviceId,licenseId
  }).database();
  await assertSucceeds(get(ref(licensed,"clinics/"+clinicCode+"/records/meta")));
  await assertSucceeds(set(ref(licensed,"clinics/"+clinicCode+"/records/meta"),{clinicName:"Updated"}));
  await assertSucceeds(get(ref(licensed,"licenses/"+licenseId)));

  const wrongLicense=env.authenticatedContext("dy_test_device",{
    role:"clinic-device",clinicCode,deviceId,licenseId:"another_license"
  }).database();
  await assertFails(get(ref(wrongLicense,"licenses/"+licenseId)));
  const wrongDeviceLicense=env.authenticatedContext("dy_test_device",{
    role:"clinic-device",clinicCode,deviceId:"other_device_123",licenseId
  }).database();
  await assertFails(get(ref(wrongDeviceLicense,"licenses/"+licenseId)));

  const unauthenticated=env.unauthenticatedContext().database();
  await assertFails(get(ref(unauthenticated,"clinics/"+clinicCode+"/records/meta")));
  await assertFails(get(ref(licensed)));
  const wrongRole=env.authenticatedContext("dy_test_device",{
    role:"owner",clinicCode,deviceId,licenseId
  }).database();
  await assertFails(get(ref(wrongRole,"clinics/"+clinicCode+"/records/meta")));

  const otherClinic=env.authenticatedContext("dy_test_device",{
    role:"clinic-device",clinicCode:"OTHER_01",deviceId,licenseId
  }).database();
  await assertFails(get(ref(otherClinic,"clinics/"+clinicCode+"/records/meta")));

  const otherDevice=env.authenticatedContext("dy_test_device",{
    role:"clinic-device",clinicCode,deviceId:"other_device_123",licenseId
  }).database();
  await assertFails(get(ref(otherDevice,"clinics/"+clinicCode+"/records/meta")));

  await assertFails(set(ref(licensed,"licenses/"+licenseId),{status:"revoked"}));

  await env.withSecurityRulesDisabled(async context=>{
    await set(ref(context.database(),"licenses/"+licenseId),{
      status:"active",clinicCode:"OTHER_01",deviceId,expiresAt:Date.now()+86400000
    });
  });
  await assertFails(get(ref(licensed,"licenses/"+licenseId)));
  await assertFails(get(ref(licensed,"clinics/"+clinicCode+"/records/meta")));

  await env.withSecurityRulesDisabled(async context=>{
    await set(ref(context.database(),"licenses/"+licenseId),{
      status:"active",clinicCode,deviceId,expiresAt:Date.now()+86400000
    });
  });

  await env.withSecurityRulesDisabled(async context=>{
    await set(ref(context.database(),"licenses/"+licenseId),{
      status:"revoked",clinicCode,deviceId,revokedAt:Date.now()
    });
  });
  await assertFails(get(ref(licensed,"clinics/"+clinicCode+"/records/meta")));

  await env.withSecurityRulesDisabled(async context=>{
    await set(ref(context.database(),"licenses/"+licenseId),{
      status:"active",clinicCode,deviceId,expiresAt:Date.now()-1000
    });
  });
  await assertFails(get(ref(licensed,"clinics/"+clinicCode+"/records/meta")));

  console.log("Firebase RTDB licensing rules: all emulator checks passed.");
} finally {
  await env.cleanup();
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { ref, get, set, goOffline, goOnline } from "firebase/database";

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

  // Two independently licensed clinics can use their own namespace, but never each other's.
  await env.withSecurityRulesDisabled(async context=>{
    const db=context.database();
    await set(ref(db,"licenses/lic_test_002"),{
      status:"active",clinicCode:"OTHER_01",deviceId:"device_identifier_456",
      expiresAt:Date.now()+86400000
    });
    await set(ref(db,"clinics/OTHER_01/records/meta"),{clinicName:"Other Clinic"});
  });
  const licensedOtherClinic=env.authenticatedContext("dy_other_device",{
    role:"clinic-device",clinicCode:"OTHER_01",deviceId:"device_identifier_456",
    licenseId:"lic_test_002"
  }).database();
  await assertSucceeds(get(ref(licensedOtherClinic,"clinics/OTHER_01/records/meta")));
  await assertSucceeds(set(ref(licensedOtherClinic,"clinics/OTHER_01/records/meta"),{clinicName:"Updated Other Clinic"}));
  await assertFails(get(ref(licensedOtherClinic,"clinics/"+clinicCode+"/records/meta")));
  await assertFails(set(ref(licensedOtherClinic,"clinics/"+clinicCode+"/records/meta"),{clinicName:"Cross-clinic write"}));
  await assertFails(get(ref(licensed,"clinics/OTHER_01/records/meta")));
  await assertFails(set(ref(licensed,"clinics/OTHER_01/records/meta"),{clinicName:"Cross-clinic write"}));

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


  // A Persian-digit clinic path must remain the exact RTDB namespace. The token and
  // license record carry the same raw path code; the registry may use its ASCII form.
  const persianClinicCode="۱۴۰۵۰۷۰۱";
  const persianLicenseId="lic_persian_001";
  const persianDeviceId="device_identifier_789";
  await env.withSecurityRulesDisabled(async context=>{
    const db=context.database();
    await set(ref(db,"licenses/"+persianLicenseId),{
      status:"active",clinicCode:persianClinicCode,deviceId:persianDeviceId,
      expiresAt:Date.now()+86400000
    });
    await set(ref(db,"clinics/"+persianClinicCode+"/records/patients/persian_patient_1"),{
      id:"persian_patient_1",name:"Persian Path Test"
    });
  });
  const persianLicensed=env.authenticatedContext("dy_persian_device",{
    role:"clinic-device",clinicCode:persianClinicCode,deviceId:persianDeviceId,licenseId:persianLicenseId
  }).database();
  await assertSucceeds(get(ref(persianLicensed,"clinics/"+persianClinicCode+"/records/patients/persian_patient_1")));
  await assertSucceeds(set(ref(persianLicensed,"clinics/"+persianClinicCode+"/records/patients/persian_patient_1"),{
    id:"persian_patient_1",name:"Persian Path Updated"
  }));
  const wrongCanonicalClaim=env.authenticatedContext("dy_persian_wrong_path",{
    role:"clinic-device",clinicCode:"14050701",deviceId:persianDeviceId,licenseId:persianLicenseId
  }).database();
  await assertFails(get(ref(wrongCanonicalClaim,"clinics/"+persianClinicCode+"/records/patients/persian_patient_1")));

  // Three independently licensed devices share one clinic and all three collections.
  const multiClinic="CLINIC_03";
  const devices=[
    {uid:"dy_multi_1",id:"device_identifier_301",license:"lic_multi_301"},
    {uid:"dy_multi_2",id:"device_identifier_302",license:"lic_multi_302"},
    {uid:"dy_multi_3",id:"device_identifier_303",license:"lic_multi_303"}
  ];
  await env.withSecurityRulesDisabled(async context=>{
    const db=context.database();
    for(const device of devices){
      await set(ref(db,"licenses/"+device.license),{
        status:"active",clinicCode:multiClinic,deviceId:device.id,expiresAt:Date.now()+86400000
      });
    }
  });
  const clients=devices.map(device=>env.authenticatedContext(device.uid,{
    role:"clinic-device",clinicCode:multiClinic,deviceId:device.id,licenseId:device.license
  }).database());
  const patientPath="clinics/"+multiClinic+"/records/patients/patient_shared_001";
  const dentistPath="clinics/"+multiClinic+"/records/dentists/dentist_shared_001";
  const appointmentPath="clinics/"+multiClinic+"/records/appointments/appointment_shared_001";
  await assertSucceeds(set(ref(clients[0],patientPath),{id:"patient_shared_001",name:"Test Patient"}));
  await assertSucceeds(set(ref(clients[1],dentistPath),{id:"dentist_shared_001",name:"Test Dentist"}));
  await assertSucceeds(set(ref(clients[2],appointmentPath),{id:"appointment_shared_001",patientId:"patient_shared_001"}));
  for(const client of clients){
    assert.equal((await assertSucceeds(get(ref(client,patientPath)))).val().name,"Test Patient");
    assert.equal((await assertSucceeds(get(ref(client,dentistPath)))).val().name,"Test Dentist");
    assert.equal((await assertSucceeds(get(ref(client,appointmentPath)))).val().patientId,"patient_shared_001");
  }
  // Simulate one device offline while another updates a record, then reconnect it.
  goOffline(clients[2]);
  await assertSucceeds(set(ref(clients[1],patientPath),{id:"patient_shared_001",name:"Updated Patient"}));
  goOnline(clients[2]);
  assert.equal((await assertSucceeds(get(ref(clients[2],patientPath)))).val().name,"Updated Patient");
  const patientCollection=await assertSucceeds(get(ref(clients[2],"clinics/"+multiClinic+"/records/patients")));
  assert.deepEqual(Object.keys(patientCollection.val()||{}),["patient_shared_001"]);

  console.log("Firebase RTDB licensing rules: all emulator checks passed.");
} finally {
  await env.cleanup();
}

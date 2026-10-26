# DENTYAR multi-clinic security architecture (pre-release)

Status: design proposal only. **Not production rules and not approved for deployment until the current Firebase data/rules and signing/release path are verified.**

## Product decisions

- Keep one DENTYAR app and one Firebase Realtime Database project for the initial rollout; do not create a Firebase project per clinic unless a clinic later requires a dedicated contractual/security boundary.
- Each clinic has an immutable internal \`clinicId\`. The existing clinic code may remain a human-facing locator, but it is not a password, secret, or authorization credential.
- Each human operator signs in with their own Firebase Authentication identity. Do not share one Firebase Auth account across independent clinics or staff members.
- Authorization is based on the authenticated \`auth.uid\` and a server-controlled membership record, never solely on a clinic code supplied by the client.
- Keep the app local-first. A local write is not proof of cloud sync; show pending/success/failure distinctly and preserve the last successful sync time on failure.
- Start on Firebase's free quota only if measured usage fits. No promise of permanent free service; document quota, backup and upgrade conditions.

## Proposed data model

\`\`\`text
/clinicMembers/{clinicId}/{uid}
  role: "owner" | "dentist" | "secretary"
  active: true
  createdAt: server timestamp

/clinics/{clinicId}/patients/{patientId}
/clinics/{clinicId}/appointments/{appointmentId}
/clinics/{clinicId}/dentists/{dentistId}
/clinics/{clinicId}/lists/{key}
/clinics/{clinicId}/formFields/{key}
/clinics/{clinicId}/treatmentPrices/{key}
/clinics/{clinicId}/meta/{key}
/clinics/{clinicId}/devices/{deviceId}
\`\`\`

The app's current \`clinics/{clinicCode}\` paths must not be migrated by simply renaming keys. First export and verify a backup, map every existing clinic code to a stable clinicId, and migrate with a rollback plan.

## Realtime Database rule requirements

1. Remove broad root-level \`.read\` / \`.write\` grants. No catch-all authenticated-user access.
2. A read/write to a clinic's business data is allowed only when \`auth != null\` and the trusted membership record for that exact clinic and \`auth.uid\` exists and is active.
3. Membership records are not client-self-service. A user must not be able to create their own membership, promote their own role, reactivate themselves, or edit another clinic's membership.
4. Bootstrap the first owner through a trusted administrative process (Firebase console/Admin SDK); do not make the first membership claimable by knowing a clinic code.
5. Do not grant read/write at \`/clinics/{clinicId}\` if child-level role restrictions are needed; RTDB permissions cascade downward. Put rules at the narrowest collection/record paths.
6. Passwords, admin credentials, and private configuration must never be stored in shared clinic data.
7. Treat a Cloudflare Worker as a transport relay only. It must never be treated as the authorization layer or hold service-account credentials in client-facing code.

## Roles (next layer after clinic boundary)

- Owner/manager: manage clinic settings and staff membership.
- Dentist: patient/treatment and appointment access required for care.
- Secretary: appointment and permitted patient-entry tasks; no finance/report access if that is the product requirement.
- Enforce permissions in server rules, not only by hiding buttons in the UI. If the required role matrix cannot be expressed safely in RTDB rules, use a trusted backend rather than weakening rules.

## Required pre-release tests

- User A can read/write their clinic; user B can read/write theirs.
- User A cannot read, list, write, delete, or subscribe to any path in clinic B even if they alter clinicId in a request.
- A user cannot add or edit their own membership/role or grant access to another UID.
- Verify each data collection and tombstone/metadata/device path; do not test patients alone.
- Test three devices, offline edits, reconnect, duplicate/conflicting edits, failed writes, sign-out and revoked membership.
- Export a backup before migration and test restoring it to a separate test namespace.
- Verify the candidate APK's signer certificate matches the installed public APK before any in-place update.
- Keep public \`update.json\` unchanged until a verified signed release exists and its exact URL is available.

## Rollout sequence

1. Inventory the deployed Firebase rules, auth account pattern, all paths and existing clinic records.
2. Create a separate test namespace/project and write rules plus automated positive/negative tests there.
3. Build a migration tool that preserves records and produces counts/checksums; test rollback.
4. Run the full device and security matrix; review costs against realistic clinic/device/record counts.
5. Only then deploy rules and migration in a planned window, validate live data, and publish the signed release.

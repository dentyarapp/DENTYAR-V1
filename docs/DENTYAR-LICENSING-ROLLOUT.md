# DENTYAR Licensing Rollout

This work is isolated on `feature/dentyar-owner-licensing-20261103`. It must not be merged into or installed over the protected V101 branch until the staged checks below are complete.

## Components

- Cloudflare Worker: `dentyar-licensing-api`
- Owner panel: `/owner`
- KV namespace: `DENTYAR_LICENSES`
- Durable Objects: `RedemptionLock` and `ActivationRateLimiter`
- Trial app source: `DENTYAR_V101_LICENSE_TRIAL.html`
- Trial APK workflow: `build-licensing-trial-apk.yml`
- RTDB rules template: `firebase-database.rules.template.json`

## Required GitHub configuration

Secrets:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `FIREBASE_SERVICE_ACCOUNT_JSON` — service account for project `dentyar-458d9`
- `DENTYAR_KEYSTORE_BASE64`
- `DENTYAR_KEYSTORE_PASSWORD`
- Optional `RESEND_API_KEY`

Repository variables:
- `DENTYAR_FIREBASE_WEB_API_KEY`
- Optional `DENTYAR_RESEND_FROM` — verified Resend sender

Email notifications are enabled only when both Resend settings exist. The API and owner panel still work without them, but requests must be reviewed in the owner panel.

## Safe rollout order

1. Wait for the licensing validation workflow to pass on the feature branch.
2. Manually run `Deploy isolated DENTYAR licensing API` from this feature branch. The workflow validates the Firebase service-account project, creates/reuses the KV namespace, applies Durable Object migrations, deploys the Worker, and checks the health endpoint, owner panel, and CORS preflight.
3. Manually run `Build DENTYAR V101 Licensing Trial APK` from this feature branch. The APK keeps package ID `com.dentyar.parallelv101`, uses version code 2, checks the established signing certificate SHA-256, verifies the APK signature/package/version, and publishes an artifact plus SHA-256 file. It does not publish a GitHub release.
4. Install and validate the trial APK on each device that must continue syncing. Each device must submit its own activation request. The owner approves each device and gives its one-time code only to that device.
5. Confirm every required device signs in with Firebase custom claims and can read/write only its own clinic path.
6. Only after all devices have migrated, apply `firebase-database.rules.template.json` to the production Realtime Database. This is intentionally not automated: applying it early would block devices still using the legacy email/password session.
7. Verify a licensed device can sync and an unlicensed/expired/revoked device cannot read or write clinic data.

## Security and compatibility notes

- The production V101 branch, existing Worker deployment, and production RTDB rules are left untouched by this feature branch.
- The licensing trial APK uses Android version code 2. Any final APK intended to update a device that installed this trial must use version code 3 or higher and the same verified DENTYAR signing certificate.
- Activation codes are device-bound. Same-device retries are allowed to recover from a lost response; another device is rejected.
- RTDB is the authorization source for clinic data. Revocation updates RTDB before the local license record.
- On Android APK, the random installation ID is encrypted with AES-GCM under a non-exportable Android Keystore key; copying browser preferences alone does not clone it. A restored backup without the original Keystore key generates a new ID and needs a new license. In PWA/browser mode, the fallback ID is stored in localStorage and can be cloned by copying browser storage; it is not hardware attestation.
- Firebase rules deployment is a migration step and must not be performed until every required device has been updated and activated.

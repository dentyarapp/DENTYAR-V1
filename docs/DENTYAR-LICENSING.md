# DENTYAR Owner Licensing (isolated rollout)

## Scope and protection

- The licensing API is a separate Cloudflare Worker. It does not replace the existing DENTYAR sync relay.
- The V101 production branch and installed V101 app remain untouched. App-side integration is isolated in `DENTYAR_V101_LICENSE_TRIAL.html` and built as a separately versioned trial APK.
- The trial app requests owner approval, redeems a one-time code, exchanges the Firebase custom token, and verifies the `clinicCode`, `deviceId`, `licenseId`, and `role` claims before connecting.
- Android trial builds obtain a device identifier encrypted with an Android Keystore AES-GCM key. Browser/PWA fallback identifiers are stored locally and are less resistant to cloning than the native Android identity.
- Do not apply the RTDB rules template to the live database until all active devices have migrated and the production cutover has been explicitly tested. The current legacy RTDB rules remain unchanged.
- Activation codes are 16 hexadecimal characters, stored as SHA-256 digests, and expire after seven days. Redemption is bound to the exact clinic/device pair; the same device may safely retry during the code lifetime, while any other device is rejected.
- Durable Objects serialize code redemption and apply a five-requests-per-minute per-IP limit to public activation requests.
- Owner endpoints require a valid Firebase ID token from the configured, verified owner email.

## Cloudflare resources

Worker: `dentyar-licensing-api`

KV binding: `LICENSES` (namespace title `DENTYAR_LICENSES`)

Durable Object bindings:
- `REDEMPTION_LOCKS` → `RedemptionLock`
- `ACTIVATION_LIMITS` → `ActivationRateLimiter`

Static assets:
- `cloudflare/licensing-panel/owner.html` → `ASSETS`

## Required GitHub configuration

Secrets:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `FIREBASE_SERVICE_ACCOUNT_JSON`

Repository variable:
- `DENTYAR_FIREBASE_WEB_API_KEY`

Optional email notification:
- Secret `RESEND_API_KEY`
- Variable `DENTYAR_RESEND_FROM` (verified Resend sender)

The Firebase service-account private key must remain only in GitHub Secrets / Cloudflare Worker secrets. Never place it in HTML, the repository, app settings, or client-side code.

## API routes

Public:
- `GET /health`
- `GET /v1/owner/config` — public Firebase web API key and project ID only
- `POST /v1/activation/request`
- `POST /v1/activation/redeem`

Owner-authenticated:
- `POST /v1/owner/requests`
- `POST /v1/owner/approve`
- `POST /v1/owner/reject`
- `POST /v1/owner/licenses`
- `POST /v1/owner/activation-code` — recover a recently issued code after a lost approval response
- `POST /v1/owner/revoke`

Owner panel: `/owner`

## Verification completed

- GitHub Actions validates Worker syntax, atomic redemption, idempotent owner approval, custom-token signature, Firebase Auth emulator token exchange, RTDB rules in the Firebase emulator, Durable Object migrations, and required secret boundaries.
- The deployed Worker health route and owner panel route are checked after deployment. Live deployment checks also verify the public Firebase configuration, malformed activation-request rejection, and CORS preflight.
- A signed V101-224 licensing trial APK is built with the established DENTYAR release certificate, package `com.dentyar.parallelv101`, and an incremented Android version code. It is a trial build, not a production release.

## Remaining cutover requirements

- Sign in to the owner panel with the verified Firebase owner account and exercise one real test clinic/device request, approval, code redemption, duplicate redemption rejection, and revocation.
- Email notifications are optional and remain disabled until `RESEND_API_KEY` and a verified `DENTYAR_RESEND_FROM` sender are configured. Without these, requests are saved and shown in the owner panel but no notification email is sent.
- The production RTDB still uses the existing legacy rules. Do not apply the restrictive template until every active device is migrated; doing so earlier would interrupt the current installed app.
- The trial build has not yet been promoted to the V101 production branch or distributed as an in-app update. A final cutover requires a coordinated device migration, production rules deployment, and live verification with the owner account.

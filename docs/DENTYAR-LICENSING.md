# DENTYAR Owner Licensing (isolated rollout)

## Scope and protection

- The licensing API is a separate Cloudflare Worker. It does not replace the existing DENTYAR sync relay.
- The V101 production branch and installed V101 app are not modified by this feature branch.
- Do not apply the RTDB rules template to the live database until the app has been integrated and a full migration test has passed.
- Activation codes are 16 hexadecimal characters, stored as SHA-256 digests, expire after seven days, and can be redeemed once for the exact clinic/device pair.
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
- `POST /v1/owner/revoke`

Owner panel: `/owner`

## Deployment procedure

1. Run the GitHub Actions workflow **Validate isolated DENTYAR licensing worker** and require every job to pass.
2. Confirm the Cloudflare account and all required secrets/variables are present.
3. Run **Deploy isolated DENTYAR licensing API** manually from this feature branch.
4. Verify `GET /health` and `GET /owner` after deployment.
5. Sign in to the owner panel with the verified Firebase owner account and verify request listing and license listing.
6. Exercise a test clinic/device request, approve it, redeem the code once, confirm a second redemption is rejected, and revoke the license.
7. Only after app-side custom-token integration and RTDB Emulator rules tests pass should the RTDB rules template be considered for production.

## Important current limitation

The Worker and owner panel are separate from the installed app. The existing app still uses its previous Firebase email/password sync flow. Do not switch production RTDB rules or distribute a new APK until app-side activation, custom-token sign-in, persistence/re-authentication, and revoked-license denial have been integrated and tested.

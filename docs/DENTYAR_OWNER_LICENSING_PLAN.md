# DENTYAR Owner-Controlled Device Licensing — Implementation Plan

## Scope and safety boundary
This work is isolated on `feature/dentyar-owner-licensing-20261103`, based on the working parallel V101 branch. Do not merge, deploy the Worker, change Firebase production rules, or publish/install an APK until the owner explicitly approves after testing.

The existing V101 parallel APK and its working phone/tablet sync are the protected baseline.

## Existing implementation findings
- The app currently signs in to Firebase Auth using a shared account.
- On connection it writes `clinics/<clinicCode>/devices/<deviceId>` immediately; this is device registration, not owner approval.
- It then subscribes to clinic records and pushes updates directly to Realtime Database.
- The current Cloudflare Worker is a transport relay only. It does not authenticate an owner, issue licenses, or enforce device authorization.
- The device ID is stored client-side and can be reset or spoofed. It is not a trusted identity.
- Therefore, a client-side activation-code screen or a local flag would be bypassable and must not be treated as security.

## Required behavior
1. A new device can submit an activation request containing clinic code, display name, app version, and a generated request identifier.
2. The request is pending and cannot read or write clinic records.
3. Only an authenticated owner can approve or reject it.
4. Approval issues a unique, single-device credential/license with a status and optional expiry.
5. Every database access is denied unless the server verifies that credential and its clinic/device scope.
6. Revocation takes effect on the next server authorization check and terminates active sync as quickly as the platform permits.
7. The app remains local-first; pending/revoked devices retain local data but cannot sync or mutate cloud data.
8. Owner notification is email-only; provider credentials must remain server-side and must never be embedded in the APK or committed to the repository.

## Security architecture decision
A code by itself is not an authorization mechanism. The code must be redeemed by a trusted server and exchanged for a Firebase-authenticated, device-scoped credential, or all database traffic must pass through a trusted authorization gateway. Firebase RTDB rules must enforce the resulting authorization; hiding UI controls is insufficient.

The current shared Firebase Auth user plus direct RTDB writes is not enough to enforce per-device revocation. Do not add a superficial client-only gate.

## Implementation phases
- Phase A: preserve baseline; define request/license data model and server endpoints; document threat model.
- Phase B: implement server-side request, owner approval, redemption, status, and revocation endpoints using server-held credentials.
- Phase C: implement Firebase authorization/rules that deny unlicensed device access and scope each license to one clinic/device.
- Phase D: add the in-app request/code redemption UI and owner-only management panel; remove direct access paths that bypass server authorization.
- Phase E: test pending, approved, rejected, expired, revoked, reinstall/reset, offline, modified client, and multi-device sync.
- Phase F: only after owner sign-off, deploy server/rules and produce a separately signed test APK; do not replace the working APK until upgrade/signature and sync tests pass.

## Secrets and operational rules
- Never place Firebase Admin private keys, email API keys, or owner credentials in client code, APKs, public repository files, or chat.
- Store secrets only in the trusted server's secret manager.
- Do not loosen RTDB rules to `auth != null` as a shortcut.
- Do not deploy a Worker change or alter production Firebase rules as part of exploratory work.

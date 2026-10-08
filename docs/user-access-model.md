# User profiles and hotel memberships

## Canonical data model

- `users/{uid}` contains identity/display fields and the `hotelUid` discovery list, not authorization permissions. Updating its contact email does not change the Firebase Auth login email.
- `hotels/{hotelUid}/members/{uid}.permissions` is the canonical source for hotel action permissions.
- The Firebase Auth `platformAdmin` claim is the platform administrator mechanism. Hotel access is no longer copied into custom claims; legacy `hotelPermissions` claims are ignored.
- `hotelSubscriptions/{hotelUid}` controls operational access independently of membership. Missing, malformed, paused, canceled and expired subscriptions deny ordinary users. Platform administrators retain management access.

Storage Rules read the membership and subscription directly from the default Firestore database. These are two distinct document lookups; repeated membership reads are cached by Rules. Production requires the cross-service authorization described in [Firebase Storage Rules](https://firebase.google.com/docs/storage/security/rules-conditions#enhance_with_cloud_firestore). Revoking membership takes effect for new authenticated Storage operations without refreshing the user's token. Already downloaded files and previously issued bearer download URLs cannot be revoked by changing Rules; private file delivery and token rotation remain release work.

Deleting the root user profile is not part of removing one hotel subscription. Remove that hotel's membership and its UID from the root profile. Delete the root profile only when the account itself is being retired, subject to the retention policy.

## User Detail save flow

The platform-only `updateUserAccess` callable validates the Auth identity and all hotel IDs. One Firestore transaction reads the authoritative previous profile, checks `expectedAccessRevision`, verifies assigned hotels, updates profile and memberships, removes memberships no longer assigned and appends a `userAccessAudit` record. Client-supplied previous hotel lists cannot suppress removals. Stale saves fail with `aborted`; reload before retrying.

Membership changes immediately control Firestore, Storage and callable authorization. The current browser permission view refreshes when hotel settings are reloaded; hiding a stale button is not the security boundary. Deploy the revised callable and Rules before the new frontend; the callable now requires `expectedAccessRevision`, so coordinate the frontend cutover or use a maintenance window. See `subscription-readiness.md` for subscription provisioning before enforcement.

The browser and callable must target the same Firebase project. The callable is deployed in `us-central1` with CORS enabled for callable clients; a CORS-like preflight failure commonly indicates that the Function does not exist in the project selected by the frontend. See `docs/firebase-environments.md` before changing allowed origins.

No cross-service claims synchronization is needed. Firebase Auth is read before the Firestore transaction; profile, memberships and audit are committed atomically in Firestore.

# User profiles and hotel memberships

## Canonical data model

HotelSuite intentionally keeps two kinds of user records:

- `users/{uid}` is the global identity/profile directory. It stores display fields and the `hotelUid` list used to discover which hotels the user can select. It must not contain authorization permissions.
- `hotels/{hotelUid}/members/{uid}` is the authorization record for one hotel. Its `permissions` array is the only Firestore, callable and frontend source for hotel actions.
- The Firebase Auth `platformAdmin` custom claim is the only platform-wide administrator mechanism.
- The Firebase Auth `hotelPermissions` map mirrors membership permissions for Storage Rules, because Storage Rules cannot read Firestore membership documents.

Deleting the root user profile is not part of removing one hotel subscription. Remove that hotel's membership and its UID from the root profile. Delete the root profile only when the account itself is being retired, subject to the retention policy.

## User Detail save flow

`UserDetailPage` loads the root profile and then loads every listed hotel membership. Permissions are edited separately for the selected hotel. Saving calls the platform-only `updateUserAccess` callable, which:

1. updates profile fields and the hotel discovery list;
2. removes the obsolete root `permissions` field;
3. creates or updates memberships for selected hotels;
4. deletes memberships for hotels removed from the profile;
5. mirrors the resulting per-hotel permissions to the user's `hotelPermissions` custom claim.

Firestore membership changes become authoritative immediately. The target user must sign in again or refresh their ID token before updated Storage claims take effect. Deploy `updateUserAccess` before deploying the frontend that calls it.

The browser and callable must target the same Firebase project. The callable is deployed in `us-central1` with CORS enabled for callable clients; a CORS-like preflight failure commonly indicates that the Function does not exist in the project selected by the frontend. See `docs/firebase-environments.md` before changing allowed origins.

The Firestore batch and Auth custom-claim update cannot form one cross-service transaction. The callable commits Firestore first and claims second so a claims failure cannot prematurely grant Storage access. If claim synchronization fails, retry the same save and inspect Functions logs.

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, getAppBaseUrl } = require("./config");
const { requirePlatformAdministrator, requireDocumentId, requireHotelSubscription } = require("./subscriptions");
const { requireHotelPermission, permissionAllows, normalizedPermissions } = require("./authorization");
const { requireVerifiedUser, text, email, digest } = require("./validation");
const { catalog, validateModules, validateSeatLimit, compileMemberAccess } = require("./modulePolicy");
const { requireHotelAdministrator, readTeamGuard, writeTeamGuard } = require("./hotelTeam");
const { gated, enforceRequestRollout, SAAS_RULES_VERSION } = require("./saasRollout");

const ROLES = {
  manager: ["dashboard.read", ...catalog.modules.procurement.roles["module-manager"].permissions],
  purchaser: ["dashboard.read", ...catalog.modules.procurement.roles.buyer.permissions],
  approver: ["dashboard.read", ...catalog.modules.procurement.roles.approver.permissions],
  viewer: ["dashboard.read", ...catalog.modules.procurement.roles.viewer.permissions],
};

async function createHotelHandler(request, services = {}) {
  requireVerifiedUser(request);
  await requirePlatformAdministrator(request, services.auth);
  const input = request.data || {};
  const requestId = requireDocumentId(input.requestId, "requestId");
  const name = text(input.name, "Hotel name", 200, true);
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  if (!/^[a-z0-9][a-z0-9-]{2,59}$/.test(hotelUid)) throw new HttpsError("invalid-argument", "Use a hotel ID of 3–60 lowercase letters, numbers or hyphens.");
  if (!["active", "trialing"].includes(input.status)) throw new HttpsError("invalid-argument", "Choose active access or a trial.");
  const trialDays = input.trialDays ?? 14;
  const modules = validateModules(input.modules ?? ["procurement"]);
  const seatLimit = validateSeatLimit(input.seatLimit ?? null);
  if (!Number.isInteger(trialDays) || trialDays < 1 || trialDays > 90) throw new HttpsError("invalid-argument", "Trials must last 1–90 days.");
  const db = services.firestore || admin.firestore();
  const stamp = () => admin.firestore.FieldValue.serverTimestamp();
  const ref = db.doc(`hotels/${hotelUid}`);
  const key = digest(request.auth.uid, requestId);
  const fingerprint = digest(hotelUid, name, input.status, trialDays, modules, seatLimit);
  const operation = db.doc(`platformOperations/${key}`);
  return db.runTransaction(async (tx) => {
    await enforceRequestRollout(db, request, tx);
    const profileRef = db.doc(`users/${request.auth.uid}`);
    const [existing, op, profile] = await Promise.all([tx.get(ref), tx.get(operation), tx.get(profileRef)]);
    if (op.exists) {
      if (op.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This request was used with different hotel details.");
      return op.data().result;
    }
    if (existing.exists) throw new HttpsError("already-exists", "This hotel ID is already in use.");
    const profileData = profile.data() || {};
    if ((profileData.hotelUid !== undefined && !Array.isArray(profileData.hotelUid))
      || !Number.isSafeInteger(profileData.accessRevision || 0)) throw new HttpsError("failed-precondition", "Review your existing hotel assignments before onboarding another hotel.");
    const validUntil = input.status === "trialing"
      ? admin.firestore.Timestamp.fromMillis((services.now?.() ?? Date.now()) + trialDays * 86400000) : null;
    const result = { hotelUid, name, status: input.status, validUntilMillis: validUntil?.toMillis() ?? null };
    tx.create(ref, { name, hotelName: name, createdAt: stamp(), createdBy: request.auth.uid, onboardingVersion: 1 });
    tx.create(db.doc(`hotels/${hotelUid}/settings/bootstrap`), { hotelName: name, currency: "EUR", language: "en" });
    // Capacity is unknown until configured; do not invent a zero-room property.
    tx.create(db.doc(`hotels/${hotelUid}/settings/propertySettings`), {});
    tx.create(db.doc(`hotelSubscriptions/${hotelUid}`), { status: input.status, planId: "standard", billingMode: "manual", modules, modulePolicyVersion: catalog.policyVersion, seatLimit, validUntil, revision: 1, updatedAt: stamp(), updatedBy: request.auth.uid });
    tx.create(db.doc(`hotels/${hotelUid}/subscriptionAudit/${key}`), { actorUid: request.auth.uid, previousStatus: null, status: input.status, planId: "standard", modules, modulePolicyVersion: catalog.policyVersion, seatLimit, validUntil, revision: 1, createdAt: stamp() });
    tx.set(profileRef, { hotelUid: admin.firestore.FieldValue.arrayUnion(hotelUid), accessRevision: (profileData.accessRevision || 0) + 1 }, { merge: true });
    tx.create(operation, { type: "create-hotel", actorUid: request.auth.uid, fingerprint, result, createdAt: stamp() });
    return result;
  });
}

async function inviteHotelUserHandler(request, services = {}) {
  requireVerifiedUser(request);
  const input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const requestId = requireDocumentId(input.requestId, "requestId");
  const recipient = email(input.email);
  const firstName = text(input.firstName || "", "First name", 80);
  const lastName = text(input.lastName || "", "Last name", 80);
  if (input.role !== undefined && !Object.hasOwn(ROLES, input.role)) throw new HttpsError("invalid-argument", "Choose a supported hotel role.");
  const db = services.firestore || admin.firestore();
  const auth = services.auth || admin.auth();
  const subscription = await requireHotelAdministrator(db, request, hotelUid, undefined, auth);
  // Older callers get an explicitly scoped procurement role, never all future permissions.
  const roleIds = { manager: "module-manager", purchaser: "buyer", approver: "approver", viewer: "viewer" };
  const selection = input.role !== undefined
    ? { moduleRoles: { procurement: [roleIds[input.role]] }, hotelAdmin: false }
    : { moduleRoles: input.moduleRoles || {}, additionalPermissions: input.additionalPermissions || [], hotelAdmin: input.hotelAdmin ?? false };
  if (input.resend !== true) compileMemberAccess(selection, subscription);
  const key = digest(request.auth.uid, requestId);
  const ref = db.doc(`hotels/${hotelUid}/invitations/${key}`);
  const fingerprint = digest(recipient, selection, firstName, lastName, input.resend === true);
  const [hotel, previous] = await Promise.all([db.doc(`hotels/${hotelUid}`).get(), ref.get()]);
  if (!hotel.exists) throw new HttpsError("not-found", "Hotel not found.");
  if (previous.exists) {
    if (previous.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This invitation request was already used.");
    return { hotelUid, uid: previous.data().uid, invitationId: key, status: "queued" };
  }
  await requireHotelSubscription(db, hotelUid);
  let user;
  let created = false;
  try { user = await auth.getUserByEmail(recipient); }
  catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
    try {
      user = await auth.createUser({ uid: `hs_${digest(recipient).slice(0, 40)}`, email: recipient, displayName: [firstName, lastName].filter(Boolean).join(" ") || undefined });
      created = true;
    } catch (createError) {
      if (!["auth/email-already-exists", "auth/uid-already-exists"].includes(createError.code)) throw createError;
      user = await auth.getUserByEmail(recipient);
    }
  }
  if (user.disabled) throw new HttpsError("failed-precondition", "This account is disabled. Review it before assigning hotel access.");
  const baseUrl = services.appBaseUrl || getAppBaseUrl();
  const signInUrl = new URL("/login", baseUrl).toString();
  // An unfinished, newly created account can resume after an interrupted invitation.
  const needsPassword = created || !user.providerData?.length;
  // Firebase's managed action pages handle credentials. The separate sign-in link
  // avoids requiring a new OAuth redirect-domain grant for App Hosting.
  const resetLink = needsPassword ? await auth.generatePasswordResetLink(recipient) : null;
  const verificationLink = !user.emailVerified ? await auth.generateEmailVerificationLink(recipient) : null;
  const profileRef = db.doc(`users/${user.uid}`);
  const memberRef = db.doc(`hotels/${hotelUid}/members/${user.uid}`);
  const mailRef = db.doc(`hotels/${hotelUid}/mailQueue/invite-${key}`);
  return db.runTransaction(async (tx) => {
    const currentSubscription = await requireHotelAdministrator(db, request, hotelUid, tx, auth);
    const [invite, member, profile] = await Promise.all([tx.get(ref), tx.get(memberRef), tx.get(profileRef)]);
    if (invite.exists) {
      if (invite.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This invitation request was already used.");
      return { hotelUid, uid: invite.data().uid, invitationId: key, status: "queued" };
    }
    if (member.exists && input.resend !== true) throw new HttpsError("already-exists", "This user already belongs to this hotel. Select resend to keep their access and send a fresh invitation.");
    if (!member.exists && input.resend === true) throw new HttpsError("not-found", "This user is not a member of this hotel.");
    const access = member.exists ? null : compileMemberAccess(selection, currentSubscription);
    const guard = member.exists ? null : await readTeamGuard(db, tx, hotelUid, {
      addingMember: true, addingAdmin: access.hotelAdmin, seatLimit: currentSubscription.seatLimit ?? null });
    const stamp = admin.firestore.FieldValue.serverTimestamp();
    const previousProfile = profile.exists ? profile.data() : {};
    if ((previousProfile.hotelUid !== undefined && !Array.isArray(previousProfile.hotelUid))
      || !Number.isSafeInteger(previousProfile.accessRevision || 0)) throw new HttpsError("failed-precondition", "Review the user's existing hotel assignments before inviting them.");
    if (!member.exists) {
      tx.set(profileRef, { email: user.email, firstName: previousProfile.firstName || firstName,
      lastName: previousProfile.lastName || lastName, hotelUid: admin.firestore.FieldValue.arrayUnion(hotelUid),
      accessRevision: (previousProfile.accessRevision || 0) + 1, updatedAt: stamp }, { merge: true });
    tx.create(memberRef, { ...access, role: input.role || null, revision: 1, email: user.email,
      firstName, lastName, createdAt: stamp, updatedBy: request.auth.uid });
    writeTeamGuard(tx, guard, request.auth.uid);
    }
    tx.create(ref, { uid: user.uid, email: user.email, role: input.role || null, fingerprint, actorUid: request.auth.uid, createdAt: stamp });
    tx.create(db.doc(`hotels/${hotelUid}/accessAudit/${key}`), { uid: user.uid, action: member.exists ? "resend-invitation" : "invite", moduleRoles: member.data()?.moduleRoles || access?.moduleRoles || {}, hotelAdmin: member.data()?.hotelAdmin === true || access?.hotelAdmin === true, actorUid: request.auth.uid, createdAt: stamp });
    tx.create(mailRef, { type: "hotel-invitation", hotelUid, uid: user.uid, actorUid: request.auth.uid, status: "queued", queuedAt: stamp,
      payload: { to: [user.email], subject: `Your HotelSuite access: ${hotel.data().name || hotelUid}`,
        text: `You have been invited to ${hotel.data().name || hotelUid}.\n\n${resetLink ? `1. Set your password: ${resetLink}\n\n` : ""}${verificationLink ? `Verify your email: ${verificationLink}\n\n` : ""}Sign in: ${signInUrl}\n\nYour hotel administrators manage your access.` } });
    return { hotelUid, uid: user.uid, invitationId: key, status: "queued" };
  });
}

async function listHotelUsersHandler(request, services = {}) {
  requireVerifiedUser(request);
  const hotelUid = requireDocumentId(request.data?.hotelUid, "hotelUid");
  const db = services.firestore || admin.firestore();
  await requireHotelPermission(db, request, hotelUid, "outlets", "approvers", undefined, services.auth);
  const afterUid = request.data?.afterUid ? requireDocumentId(request.data.afterUid, "afterUid") : null;
  let query = db.collection(`hotels/${hotelUid}/members`).orderBy(admin.firestore.FieldPath.documentId());
  if (afterUid) query = query.startAfter(afterUid);
  const members = await query.limit(51).get();
  const page = members.docs.slice(0, 50);
  const profiles = page.length ? await db.getAll(...page.map((m) => db.doc(`users/${m.id}`))) : [];
  return { users: page.map((member, i) => ({ id: member.id,
    firstName: String(member.data().firstName ?? profiles[i].data()?.firstName ?? ""), lastName: String(member.data().lastName ?? profiles[i].data()?.lastName ?? ""),
    email: String(profiles[i].data()?.email || ""),
    canApprove: permissionAllows(normalizedPermissions(member.data().permissions), "orders", "approve") })),
    nextCursor: members.size > 50 ? page.at(-1).id : null };
}

async function getHotelOnboardingStatusHandler(request, services = {}) {
  requireVerifiedUser(request); await requirePlatformAdministrator(request, services.auth);
  const db = services.firestore || admin.firestore();
  const status = (await db.doc("platformConfiguration/saasProcurement").get()).data();
  return { enabled: status?.enabled === true && status.rulesVersion === SAAS_RULES_VERSION };
}

const options = { region: "us-central1", cors: true };
module.exports = { ROLES, createHotelHandler, inviteHotelUserHandler, listHotelUsersHandler,
  createHotel: onCall(options, gated(createHotelHandler)), inviteHotelUser: onCall(options, gated(inviteHotelUserHandler)),
  listHotelUsers: onCall(options, listHotelUsersHandler), getHotelOnboardingStatusHandler,
  getHotelOnboardingStatus: onCall(options, getHotelOnboardingStatusHandler) };

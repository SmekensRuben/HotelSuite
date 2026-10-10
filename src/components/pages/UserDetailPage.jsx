import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { auth, signOut } from "../../firebaseConfig";
import { getUserById, getUserMemberships, updateUserWithMemberships } from "../../services/firebaseUserManagement";
import { listAllPermissionKeys, PERMISSION_CATALOG } from "../../constants/permissionCatalog";
import { usePermission } from "../../hooks/usePermission";
import { usePlatformScope } from "../../hooks/usePlatformQuery";

function normalizeCsvToArray(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values) {
  return Array.from(new Set(values));
}

export default function UserDetailPage({ platform = false }) {
  const { userId } = useParams();
  return <ScopedUserDetailPage key={`${userId}:${platform}`} userId={userId} platform={platform} />;
}

function ScopedUserDetailPage({ userId, platform }) {
  const navigate = useNavigate();
  const usersPath = platform ? "/platform/users" : "/settings/users";
  const capture = usePlatformScope(userId);
  const hotelCanUpdateUsers = usePermission("users", "update");
  const canUpdateUsers = platform || hotelCanUpdateUsers;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [hotelUidsInput, setHotelUidsInput] = useState("");
  const [accessRevision, setAccessRevision] = useState(0);
  const [selectedHotelUid, setSelectedHotelUid] = useState("");
  const [memberships, setMemberships] = useState({});
  const [message, setMessage] = useState("");

  const knownPermissionKeys = useMemo(() => listAllPermissionKeys(), []);

  const today = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    []
  );

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  useEffect(() => {
    let active = true;
    const loadUser = async () => {
      if (!canUpdateUsers || !userId) return;

      setLoading(true);
      setLoadError(false);
      try {
      const user = await getUserById(userId);
      if (!active) return;

      if (!user) {
        setLoadError(true);
        setMessage("User not found.");
        setLoading(false);
        return;
      }

      setFirstName(user.firstName || "");
      setLastName(user.lastName || "");
      setEmail(user.email || "");

      const hotelUids = Array.isArray(user.hotelUid) ? unique(user.hotelUid.filter(Boolean)) : [];
      const loadedMemberships = await getUserMemberships(userId, hotelUids);
      if (!active) return;
      setHotelUidsInput(hotelUids.join(", "));
      setAccessRevision(user.accessRevision || 0);
      setSelectedHotelUid(hotelUids[0] || "");
      setMemberships(loadedMemberships);

      setLoading(false);
      } catch {
        if (active) { setLoadError(true); setMessage("User access could not be loaded. Refresh before editing."); setLoading(false); }
      }
    };

    loadUser();
    return () => { active = false; };
  }, [canUpdateUsers, knownPermissionKeys, userId]);

  const hotelUids = normalizeCsvToArray(hotelUidsInput);
  const selectedHotelPermissions = unique((memberships[selectedHotelUid] || []).map((key) => key.trim().toLowerCase()));
  const selectedPermissions = selectedHotelPermissions.filter((permission) => knownPermissionKeys.includes(permission));

  const setPermissionsForSelectedHotel = (permissions) => {
    if (!selectedHotelUid) return;
    setMemberships((previous) => ({ ...previous, [selectedHotelUid]: unique(permissions) }));
  };

  const togglePermission = (permissionKey) => {
    setPermissionsForSelectedHotel(
      selectedHotelPermissions.includes(permissionKey)
        ? selectedHotelPermissions.filter((permission) => permission !== permissionKey)
        : [...selectedHotelPermissions, permissionKey],
    );
  };

  const handleSave = async (event) => {
    event.preventDefault();
    if (!canUpdateUsers || !userId || saving || loadError || loading) return;
    const current = capture();

    setSaving(true);
    setMessage("");

    const payload = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      hotelUid: hotelUids,
    };

    try {
      const result = await updateUserWithMemberships(userId, payload, memberships, accessRevision);
      if (!current()) return;
      setAccessRevision(result.accessRevision);
      setMessage("User profile and hotel permissions saved.");
    } catch (error) {
      if (!current()) return;
      console.error(error);
      const unavailable = error?.code === "functions/not-found"
        || error?.code === "functions/internal"
        || /failed to fetch|cors/i.test(String(error?.message || ""));
      setMessage(error?.code === "functions/aborted"
        ? "These permissions changed. Reload before saving again."
        : unavailable
        ? "Saving failed: the user access service is unavailable. Check the Functions deployment before retrying."
        : "Saving failed. Retry or contact the platform operator.");
    } finally {
      if (current()) setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold">User Detail</h1>
            <p className="text-gray-600 mt-1">
              Update the user profile and assign permissions separately for each hotel.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate(usersPath)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100"
          >
            Back to users
          </button>
        </div>

        {loading ? (
          <p className="text-gray-600">Loading user...</p>
        ) : loadError ? (
          <div role="alert" className="rounded-xl border bg-white p-6"><p>{message}</p><button className="mt-4 rounded-lg border px-3 py-2" onClick={() => window.location.reload()}>Reload user access</button></div>
        ) : (
          <form
            onSubmit={handleSave}
            className="space-y-4 rounded-xl border border-gray-200 bg-white p-6 shadow-sm"
          >
            <div className="grid gap-4 md:grid-cols-2">
              <label className="text-sm font-medium text-gray-700">
                First name
                <input
                  type="text"
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
                />
              </label>

              <label className="text-sm font-medium text-gray-700">
                Last name
                <input
                  type="text"
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
                />
              </label>
            </div>

            <label className="block text-sm font-medium text-gray-700">
              Email
              <input
                type="email"
                value={email}
                readOnly
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
              />
              <span className="mt-1 block text-xs text-gray-500">The sign-in email is managed by Firebase Authentication.</span>
            </label>

            <label className="block text-sm font-medium text-gray-700">
              Hotel UID(s) (comma separated)
              <input
                type="text"
                value={hotelUidsInput}
                onChange={(event) => {
                  const value = event.target.value;
                  const nextHotelUids = normalizeCsvToArray(value);
                  setHotelUidsInput(value);
                  if (!nextHotelUids.includes(selectedHotelUid)) setSelectedHotelUid(nextHotelUids[0] || "");
                }}
                placeholder="hotel-a, hotel-b"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
              />
            </label>

            {hotelUids.length > 0 && (
              <label className="block text-sm font-medium text-gray-700">
                Hotel to manage
                <select
                  value={hotelUids.includes(selectedHotelUid) ? selectedHotelUid : ""}
                  onChange={(event) => setSelectedHotelUid(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="" disabled>Choose a hotel</option>
                  {hotelUids.map((hotelUid) => <option key={hotelUid} value={hotelUid}>{hotelUid}</option>)}
                </select>
              </label>
            )}

            {selectedHotelUid && hotelUids.includes(selectedHotelUid) && <div className="space-y-3 rounded-lg border border-gray-200 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-gray-800">Permissions for {selectedHotelUid}</h2>
                <button type="button" className="text-sm font-semibold text-red-700" onClick={() => setPermissionsForSelectedHotel([])}>Remove all permissions for this hotel</button>
              </div>
              {Object.entries(PERMISSION_CATALOG).map(([feature, actions]) => (
                <div key={feature} className="space-y-2">
                  <p className="text-sm font-medium capitalize text-gray-700">{feature}</p>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {[...actions, "*"].map((action) => {
                      const permissionKey = `${feature}.${action}`;
                      const isChecked = selectedPermissions.includes(permissionKey);

                      return (
                        <label
                          key={permissionKey}
                          className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => togglePermission(permissionKey)}
                            className="h-4 w-4 rounded border-gray-300 text-[#b41f1f] focus:ring-[#b41f1f]/30"
                          />
                          <span>{action === "*" ? "All actions" : action}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>}

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={!canUpdateUsers || saving}
                className="inline-flex items-center rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919] disabled:cursor-not-allowed disabled:opacity-70"
              >
                {saving ? "Saving..." : "Save"}
              </button>
              {message && <p className="text-sm text-gray-600">{message}</p>}
            </div>
          </form>
        )}
      </PageContainer>
    </div>
  );
}

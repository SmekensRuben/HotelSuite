import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { auth, signOut } from "../../firebaseConfig";
import { getUserById, getUserMemberships, updateUserWithMemberships } from "../../services/firebaseUserManagement";
import { listAllPermissionKeys, PERMISSION_CATALOG } from "../../constants/permissionCatalog";
import { usePermission } from "../../hooks/usePermission";

function normalizeCsvToArray(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values) {
  return Array.from(new Set(values));
}

export default function UserDetailPage() {
  const navigate = useNavigate();
  const { userId } = useParams();
  const canUpdateUsers = usePermission("users", "update");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [hotelUidsInput, setHotelUidsInput] = useState("");
  const [originalHotelUids, setOriginalHotelUids] = useState([]);
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
    const loadUser = async () => {
      if (!canUpdateUsers || !userId) return;

      setLoading(true);
      const user = await getUserById(userId);

      if (!user) {
        setMessage("Gebruiker niet gevonden.");
        setLoading(false);
        return;
      }

      setFirstName(user.firstName || "");
      setLastName(user.lastName || "");
      setEmail(user.email || "");

      const hotelUids = Array.isArray(user.hotelUid) ? unique(user.hotelUid.filter(Boolean)) : [];
      setHotelUidsInput(hotelUids.join(", "));
      setOriginalHotelUids(hotelUids);
      setSelectedHotelUid(hotelUids[0] || "");
      setMemberships(await getUserMemberships(userId, hotelUids));

      setLoading(false);
    };

    loadUser();
  }, [canUpdateUsers, knownPermissionKeys, userId]);

  const hotelUids = normalizeCsvToArray(hotelUidsInput);
  const selectedHotelPermissions = unique(memberships[selectedHotelUid] || []);
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
    if (!canUpdateUsers || !userId) return;

    setSaving(true);
    setMessage("");

    const payload = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      hotelUid: hotelUids,
    };

    try {
      await updateUserWithMemberships(userId, payload, memberships, originalHotelUids);
      setOriginalHotelUids(hotelUids);
      setMessage("Gebruikersprofiel en hotelpermissies opgeslagen. De gebruiker moet opnieuw inloggen om bestandsrechten te vernieuwen.");
    } catch (error) {
      console.error(error);
      setMessage("Opslaan mislukt. Controleer de Functions-logs; membership- en tokenupdates kunnen opnieuw gesynchroniseerd moeten worden.");
    } finally {
      setSaving(false);
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
              Werk het globale gebruikersprofiel en de permissies per hotel bij.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate("/settings/users")}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100"
          >
            Terug naar lijst
          </button>
        </div>

        {loading ? (
          <p className="text-gray-600">Gebruiker laden...</p>
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
                onChange={(event) => setEmail(event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
              />
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
                Hotel waarvoor je permissies bewerkt
                <select
                  value={hotelUids.includes(selectedHotelUid) ? selectedHotelUid : ""}
                  onChange={(event) => setSelectedHotelUid(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="" disabled>Selecteer een hotel</option>
                  {hotelUids.map((hotelUid) => <option key={hotelUid} value={hotelUid}>{hotelUid}</option>)}
                </select>
              </label>
            )}

            {selectedHotelUid && hotelUids.includes(selectedHotelUid) && <div className="space-y-3 rounded-lg border border-gray-200 p-4">
              <h2 className="text-sm font-semibold text-gray-800">Permissions voor {selectedHotelUid}</h2>
              {Object.entries(PERMISSION_CATALOG).map(([feature, actions]) => (
                <div key={feature} className="space-y-2">
                  <p className="text-sm font-medium capitalize text-gray-700">{feature}</p>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {actions.map((action) => {
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
                          <span>{action}</span>
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
                {saving ? "Opslaan..." : "Opslaan"}
              </button>
              {message && <p className="text-sm text-gray-600">{message}</p>}
            </div>
          </form>
        )}
      </PageContainer>
    </div>
  );
}

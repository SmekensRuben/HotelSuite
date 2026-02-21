import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { auth, signOut } from "../../firebaseConfig";
import { getUserById, updateUser } from "../../services/firebaseUserManagement";
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
  const [selectedPermissions, setSelectedPermissions] = useState([]);
  const [customPermissionsInput, setCustomPermissionsInput] = useState("");
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

      const hotelUid = Array.isArray(user.hotelUid) ? user.hotelUid : [];
      setHotelUidsInput(hotelUid.join(", "));

      const loadedPermissions = Array.isArray(user.permissions) ? unique(user.permissions) : [];
      setSelectedPermissions(
        loadedPermissions.filter((permission) => knownPermissionKeys.includes(permission))
      );
      setCustomPermissionsInput(
        loadedPermissions
          .filter((permission) => !knownPermissionKeys.includes(permission))
          .join(", ")
      );

      setLoading(false);
    };

    loadUser();
  }, [canUpdateUsers, knownPermissionKeys, userId]);

  const togglePermission = (permissionKey) => {
    setSelectedPermissions((previous) =>
      previous.includes(permissionKey)
        ? previous.filter((permission) => permission !== permissionKey)
        : [...previous, permissionKey]
    );
  };

  const handleSave = async (event) => {
    event.preventDefault();
    if (!canUpdateUsers || !userId) return;

    setSaving(true);
    setMessage("");

    const hotelUid = normalizeCsvToArray(hotelUidsInput);
    const customPermissions = normalizeCsvToArray(customPermissionsInput);

    const payload = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      hotelUid,
      permissions: unique([...selectedPermissions, ...customPermissions]),
    };

    await updateUser(userId, payload);
    setSaving(false);
    setMessage("Gebruiker opgeslagen.");
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold">User Detail</h1>
            <p className="text-gray-600 mt-1">
              Werk gebruikersgegevens, hotelUid en permissies bij.
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
                onChange={(event) => setHotelUidsInput(event.target.value)}
                placeholder="hotel-a, hotel-b"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
              />
            </label>

            <div className="space-y-3 rounded-lg border border-gray-200 p-4">
              <h2 className="text-sm font-semibold text-gray-800">Permissions per entity</h2>
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
            </div>

            <label className="block text-sm font-medium text-gray-700">
              Extra permissions (optioneel, comma separated)
              <input
                type="text"
                value={customPermissionsInput}
                onChange={(event) => setCustomPermissionsInput(event.target.value)}
                placeholder="feature.action"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
              />
            </label>

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

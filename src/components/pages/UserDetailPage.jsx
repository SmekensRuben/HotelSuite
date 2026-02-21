import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { auth, signOut } from "../../firebaseConfig";
import { getUserById, updateUser } from "../../services/firebaseUserManagement";

function normalizeCsvToArray(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export default function UserDetailPage() {
  const navigate = useNavigate();
  const { userId } = useParams();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [hotelUidsInput, setHotelUidsInput] = useState("");
  const [permissionsInput, setPermissionsInput] = useState("");
  const [message, setMessage] = useState("");

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
      if (!userId) return;

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

      const hotelUids = Array.isArray(user.hotelUids)
        ? user.hotelUids
        : [user.hotelUid].filter(Boolean);
      setHotelUidsInput(hotelUids.join(", "));

      setPermissionsInput(
        Array.isArray(user.permissions) ? user.permissions.join(", ") : ""
      );

      setLoading(false);
    };

    loadUser();
  }, [userId]);

  const handleSave = async (event) => {
    event.preventDefault();
    if (!userId) return;

    setSaving(true);
    setMessage("");

    const hotelUids = normalizeCsvToArray(hotelUidsInput);

    const payload = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      hotelUids,
      hotelUid: hotelUids[0] || "",
      permissions: normalizeCsvToArray(permissionsInput),
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

            <label className="block text-sm font-medium text-gray-700">
              Permissions (comma separated)
              <input
                type="text"
                value={permissionsInput}
                onChange={(event) => setPermissionsInput(event.target.value)}
                placeholder="products.view, products.create"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
              />
            </label>

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={saving}
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

import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Pencil, Plus, Trash2 } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { deleteRole, getRoles } from "../../services/firebaseRoles";

export default function RolesPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);

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

  const loadRoles = async () => {
    if (!hotelUid) return;
    setLoading(true);
    const result = await getRoles(hotelUid);
    setRoles(result);
    setLoading(false);
  };

  useEffect(() => {
    loadRoles();
  }, [hotelUid]);

  const handleDelete = async (role) => {
    if (!window.confirm(`Wil je de role \"${role.name}\" verwijderen?`)) {
      return;
    }

    await deleteRole(hotelUid, role.id);
    await loadRoles();
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Settings</p>
            <h1 className="text-3xl font-semibold">Roles</h1>
            <p className="text-gray-600 mt-1">Beheer rollen en bijhorende permissies.</p>
          </div>
          <button
            type="button"
            onClick={() => navigate("/settings/roles/new")}
            className="inline-flex items-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919]"
          >
            <Plus className="h-4 w-4" /> Nieuwe role
          </button>
        </div>

        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Naam
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Permissions
                </th>
                <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {!loading && roles.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-sm text-gray-500">
                    Geen roles gevonden.
                  </td>
                </tr>
              )}
              {roles.map((role) => (
                <tr key={role.id}>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">{role.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">
                    {Array.isArray(role.permissions) && role.permissions.length > 0
                      ? role.permissions.join(", ")
                      : "-"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => navigate(`/settings/roles/${role.id}/edit`)}
                        className="rounded-md border border-gray-300 p-2 text-gray-700 hover:bg-gray-100"
                        aria-label={`Bewerk ${role.name}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(role)}
                        className="rounded-md border border-red-200 p-2 text-red-700 hover:bg-red-50"
                        aria-label={`Verwijder ${role.name}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PageContainer>
    </div>
  );
}

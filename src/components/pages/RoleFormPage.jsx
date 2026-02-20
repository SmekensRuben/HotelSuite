import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { PERMISSION_CATALOG, listAllPermissionKeys } from "../../constants/permissionCatalog";
import { createRole, getRoles, updateRole } from "../../services/firebaseRoles";

export default function RoleFormPage() {
  const navigate = useNavigate();
  const { roleId } = useParams();
  const isEdit = Boolean(roleId);
  const { hotelUid } = useHotelContext();

  const [name, setName] = useState("");
  const [selectedPermissions, setSelectedPermissions] = useState([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(isEdit);

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
    const loadRole = async () => {
      if (!isEdit || !hotelUid) return;
      setLoading(true);
      const roles = await getRoles(hotelUid);
      const role = roles.find((item) => item.id === roleId);
      if (!role) {
        navigate("/settings/roles");
        return;
      }

      setName(String(role.name || ""));
      setSelectedPermissions(Array.isArray(role.permissions) ? role.permissions : []);
      setLoading(false);
    };

    loadRole();
  }, [hotelUid, isEdit, navigate, roleId]);

  const togglePermission = (permissionKey) => {
    setSelectedPermissions((current) =>
      current.includes(permissionKey)
        ? current.filter((permission) => permission !== permissionKey)
        : [...current, permissionKey]
    );
  };

  const handleToggleAll = () => {
    const allPermissions = listAllPermissionKeys();
    if (selectedPermissions.length === allPermissions.length) {
      setSelectedPermissions([]);
      return;
    }

    setSelectedPermissions(allPermissions);
  };

  const handleSave = async (event) => {
    event.preventDefault();
    if (!hotelUid || !name.trim()) return;

    setSaving(true);
    const payload = {
      name: name.trim(),
      permissions: selectedPermissions.sort(),
    };

    if (isEdit) {
      await updateRole(hotelUid, roleId, payload);
    } else {
      await createRole(hotelUid, payload);
    }

    setSaving(false);
    navigate("/settings/roles");
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 text-gray-900">
        <HeaderBar today={today} onLogout={handleLogout} />
        <PageContainer>
          <p className="text-gray-600">Role laden...</p>
        </PageContainer>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Settings</p>
            <h1 className="text-3xl font-semibold">{isEdit ? "Role bewerken" : "Nieuwe role"}</h1>
            <p className="text-gray-600 mt-1">Kies de permissions voor deze role.</p>
          </div>
        </div>

        <form onSubmit={handleSave} className="space-y-4 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <label className="block text-sm font-medium text-gray-700">
            Role naam
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="bijv. product-manager"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
              required
            />
          </label>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-600">Permissions</h2>
              <button
                type="button"
                onClick={handleToggleAll}
                className="rounded-md border border-gray-300 px-2 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-100"
              >
                {selectedPermissions.length === listAllPermissionKeys().length
                  ? "Alles uitzetten"
                  : "Alles aanvinken"}
              </button>
            </div>

            {Object.entries(PERMISSION_CATALOG).map(([feature, actions]) => (
              <div key={feature} className="rounded-lg border border-gray-200 p-4">
                <p className="text-sm font-semibold capitalize text-gray-800 mb-2">{feature}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {actions.map((action) => {
                    const permissionKey = `${feature}.${action}`;
                    return (
                      <label key={permissionKey} className="inline-flex items-center gap-2 text-sm text-gray-700">
                        <input
                          type="checkbox"
                          checked={selectedPermissions.includes(permissionKey)}
                          onChange={() => togglePermission(permissionKey)}
                        />
                        {permissionKey}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919] disabled:cursor-not-allowed disabled:opacity-70"
            >
              {saving ? "Opslaan..." : "Opslaan"}
            </button>
            <button
              type="button"
              onClick={() => navigate("/settings/roles")}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100"
            >
              Annuleren
            </button>
          </div>
        </form>
      </PageContainer>
    </div>
  );
}

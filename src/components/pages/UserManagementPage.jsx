import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { getAllUsers } from "../../services/firebaseUserManagement";
import { usePermission } from "../../hooks/usePermission";

function formatHotelUid(user) {
  const userHotelUids = Array.isArray(user.hotelUid) ? user.hotelUid.filter(Boolean) : [];

  return userHotelUids.join(", ") || "-";
}

function formatPermissions(user) {
  return Array.isArray(user.permissions) ? user.permissions.join(", ") || "-" : "-";
}

export default function UserManagementPage() {
  const navigate = useNavigate();
  const canUpdateSettings = usePermission("settings", "update");
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");

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
    const loadUsers = async () => {
      setLoading(true);
      const result = await getAllUsers();
      setUsers(result);
      setLoading(false);
    };

    loadUsers();
  }, []);

  const filteredUsers = useMemo(() => {
    const normalizedTerm = searchTerm.trim().toLowerCase();
    if (!normalizedTerm) return users;

    return users.filter((user) => {
      const firstName = String(user.firstName || "").toLowerCase();
      const lastName = String(user.lastName || "").toLowerCase();
      return firstName.includes(normalizedTerm) || lastName.includes(normalizedTerm);
    });
  }, [users, searchTerm]);

  const rows = useMemo(
    () =>
      filteredUsers.map((user) => ({
        ...user,
        hotelUidLabel: formatHotelUid(user),
        permissionsLabel: formatPermissions(user),
      })),
    [filteredUsers]
  );

  const columns = [
    { key: "firstName", label: "First name" },
    { key: "lastName", label: "Last name" },
    { key: "email", label: "Email" },
    { key: "hotelUidLabel", label: "Hotel UID", sortable: false },
    { key: "permissionsLabel", label: "Permissions", sortable: false },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <h1 className="text-3xl font-semibold">User Management</h1>
          <p className="text-gray-600 mt-1">Overview van alle gebruikers.</p>
        </div>

        <div>
          <label className="sr-only" htmlFor="users-search">
            Search users
          </label>
          <input
            id="users-search"
            type="text"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Zoek op voornaam of achternaam"
            className="w-full max-w-lg rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
          />
        </div>

        {loading ? (
          <p className="text-gray-600">Gebruikers laden...</p>
        ) : (
          <DataListTable
            columns={columns}
            rows={rows}
            onRowClick={canUpdateSettings ? (user) => navigate(`/settings/users/${user.id}`) : undefined}
            emptyMessage="Geen gebruikers gevonden."
          />
        )}
      </PageContainer>
    </div>
  );
}

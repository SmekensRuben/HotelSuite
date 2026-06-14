import React, { useEffect, useMemo, useState } from "react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSettings, setSettings } from "../../services/firebaseSettings";
import { usePermission } from "../../hooks/usePermission";

function normalizeMappings(rawMappings) {
  if (!rawMappings || typeof rawMappings !== "object") return [];

  return Object.entries(rawMappings)
    .map(([operaUser, employeeName]) => ({
      operaUser: String(operaUser || "").trim(),
      employeeName: String(employeeName || "").trim(),
    }))
    .filter((mapping) => mapping.operaUser || mapping.employeeName)
    .sort((firstMapping, secondMapping) =>
      firstMapping.operaUser.localeCompare(secondMapping.operaUser, undefined, {
        sensitivity: "base",
        numeric: true,
      })
    );
}

function toMappingObject(mappings) {
  return mappings.reduce((accumulator, mapping) => {
    const operaUser = String(mapping.operaUser || "").trim();
    const employeeName = String(mapping.employeeName || "").trim();

    if (operaUser && employeeName) {
      accumulator[operaUser] = employeeName;
    }

    return accumulator;
  }, {});
}

export default function OperaSettingsPage() {
  const { hotelUid } = useHotelContext();
  const canCreateSettings = usePermission("settings", "create");
  const canUpdateSettings = usePermission("settings", "update");
  const canDeleteSettings = usePermission("settings", "delete");
  const [mappings, setMappings] = useState([]);
  const [operaUser, setOperaUser] = useState("");
  const [employeeName, setEmployeeName] = useState("");
  const [editingOperaUser, setEditingOperaUser] = useState("");
  const [editingEmployeeName, setEditingEmployeeName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const todayLabel = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    []
  );

  useEffect(() => {
    let active = true;

    async function loadOperaSettings() {
      if (!hotelUid) {
        setMappings([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");
      setMessage("");

      try {
        const settings = await getSettings(hotelUid);
        if (!active) return;
        setMappings(normalizeMappings(settings?.operaUserMappings));
      } catch (err) {
        console.error("Fout bij laden van Opera settings:", err);
        if (!active) return;
        setError("De Opera settings konden niet geladen worden.");
      } finally {
        if (active) setLoading(false);
      }
    }

    loadOperaSettings();

    return () => {
      active = false;
    };
  }, [hotelUid]);

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  const persistMappings = async (nextMappings, successMessage) => {
    if (!hotelUid) {
      setError("Geen hotel geselecteerd om Opera settings op te slaan.");
      return false;
    }

    setSaving(true);
    setError("");
    setMessage("");

    try {
      await setSettings(hotelUid, { operaUserMappings: toMappingObject(nextMappings) });
      setMappings(normalizeMappings(toMappingObject(nextMappings)));
      setMessage(successMessage);
      return true;
    } catch (err) {
      console.error("Fout bij opslaan van Opera settings:", err);
      setError("De Opera settings konden niet opgeslagen worden in Firebase.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleAddMapping = async (event) => {
    event.preventDefault();
    if (!canCreateSettings) return;

    const cleanedOperaUser = operaUser.trim();
    const cleanedEmployeeName = employeeName.trim();

    if (!cleanedOperaUser || !cleanedEmployeeName) {
      setError("Vul zowel een Opera PMS username als een employee naam in.");
      setMessage("");
      return;
    }

    const nextMappings = [
      ...mappings.filter(
        (mapping) => mapping.operaUser.toLowerCase() !== cleanedOperaUser.toLowerCase()
      ),
      { operaUser: cleanedOperaUser, employeeName: cleanedEmployeeName },
    ];

    const saved = await persistMappings(nextMappings, "Opera user mapping opgeslagen.");
    if (saved) {
      setOperaUser("");
      setEmployeeName("");
    }
  };

  const startEdit = (mapping) => {
    setEditingOperaUser(mapping.operaUser);
    setEditingEmployeeName(mapping.employeeName);
    setError("");
    setMessage("");
  };

  const handleSaveEdit = async () => {
    if (!canUpdateSettings || !editingOperaUser) return;

    const cleanedEmployeeName = editingEmployeeName.trim();
    if (!cleanedEmployeeName) {
      setError("Employee naam mag niet leeg zijn.");
      setMessage("");
      return;
    }

    const nextMappings = mappings.map((mapping) =>
      mapping.operaUser === editingOperaUser
        ? { ...mapping, employeeName: cleanedEmployeeName }
        : mapping
    );

    const saved = await persistMappings(nextMappings, "Opera user mapping bijgewerkt.");
    if (saved) {
      setEditingOperaUser("");
      setEditingEmployeeName("");
    }
  };

  const handleDelete = async (targetOperaUser) => {
    if (!canDeleteSettings || !targetOperaUser) return;
    const shouldDelete = window.confirm(`Mapping voor ${targetOperaUser} verwijderen?`);
    if (!shouldDelete) return;

    await persistMappings(
      mappings.filter((mapping) => mapping.operaUser !== targetOperaUser),
      "Opera user mapping verwijderd."
    );
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={todayLabel} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">Settings</p>
          <h1 className="text-3xl font-semibold">Opera Settings</h1>
          <p className="mt-1 text-gray-600">
            Koppel Opera PMS usernames aan de echte naam van de employee voor rapportages.
          </p>
        </div>

        <Card className="space-y-6">
          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          {message ? (
            <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
              {message}
            </div>
          ) : null}

          <form className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end" onSubmit={handleAddMapping}>
            <label className="text-sm font-semibold text-gray-700">
              Opera PMS username
              <input
                type="text"
                value={operaUser}
                onChange={(event) => setOperaUser(event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                placeholder="Bijvoorbeeld OPERAUSER1"
                disabled={!canCreateSettings || saving}
              />
            </label>
            <label className="text-sm font-semibold text-gray-700">
              Employee naam
              <input
                type="text"
                value={employeeName}
                onChange={(event) => setEmployeeName(event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                placeholder="Bijvoorbeeld Jane Doe"
                disabled={!canCreateSettings || saving}
              />
            </label>
            <button
              type="submit"
              disabled={!canCreateSettings || saving}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Opslaan..." : "Toevoegen"}
            </button>
          </form>

          {loading ? (
            <div className="text-sm text-gray-500">Opera settings worden geladen...</div>
          ) : mappings.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 p-6 text-sm text-gray-500">
              Nog geen Opera PMS usernames ingesteld.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Opera PMS username</th>
                    <th className="px-4 py-3">Employee naam</th>
                    <th className="px-4 py-3 text-right">Acties</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {mappings.map((mapping) => (
                    <tr key={mapping.operaUser}>
                      <td className="px-4 py-3 font-medium text-gray-900">{mapping.operaUser}</td>
                      <td className="px-4 py-3">
                        {editingOperaUser === mapping.operaUser ? (
                          <input
                            type="text"
                            value={editingEmployeeName}
                            onChange={(event) => setEditingEmployeeName(event.target.value)}
                            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                            disabled={saving}
                          />
                        ) : (
                          mapping.employeeName
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {editingOperaUser === mapping.operaUser ? (
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={handleSaveEdit}
                              disabled={saving}
                              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                            >
                              Opslaan
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingOperaUser("")}
                              disabled={saving}
                              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 disabled:opacity-60"
                            >
                              Annuleren
                            </button>
                          </div>
                        ) : (
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => startEdit(mapping)}
                              disabled={!canUpdateSettings || saving}
                              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 disabled:opacity-60"
                            >
                              Bewerken
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDelete(mapping.operaUser)}
                              disabled={!canDeleteSettings || saving}
                              className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-700 disabled:opacity-60"
                            >
                              Verwijderen
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </PageContainer>
    </div>
  );
}

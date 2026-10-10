import React, { useEffect, useMemo, useRef, useState } from "react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import {
  getOperaSettings, createOperaUserMapping, updateOperaUserMapping, deleteOperaUserMapping,
} from "../../services/firebaseSettings";
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

export default function OperaSettingsPage() {
  const { hotelUid } = useHotelContext();
  const canCreateSettings = usePermission("integrations", "create");
  const canUpdateSettings = usePermission("integrations", "update");
  const canDeleteSettings = usePermission("integrations", "delete");
  const [mappings, setMappings] = useState([]);
  const [operaUser, setOperaUser] = useState("");
  const [employeeName, setEmployeeName] = useState("");
  const [editingOperaUser, setEditingOperaUser] = useState("");
  const [editingEmployeeName, setEditingEmployeeName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const requestVersion = useRef(0);

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
    setOperaUser("");
    setEmployeeName("");
    setEditingOperaUser("");
    setEditingEmployeeName("");
  }, [hotelUid]);

  useEffect(() => {
    const version = ++requestVersion.current;
    setMappings([]);
    setSaving(false);

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
        const settings = await getOperaSettings(hotelUid);
        if (version !== requestVersion.current) return;
        setMappings(normalizeMappings(settings?.operaUserMappings));
      } catch (err) {
        console.error("Failed to load Opera settings:", err);
        if (version !== requestVersion.current) return;
        setError("Opera settings could not be loaded.");
      } finally {
        if (version === requestVersion.current) setLoading(false);
      }
    }

    loadOperaSettings();

    return () => {
      ++requestVersion.current;
    };
  }, [hotelUid, loadAttempt]);

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  const persistMapping = async (mutation, successMessage) => {
    if (!hotelUid || saving) return false;
    const version = requestVersion.current;
    setSaving(true);
    setError("");
    setMessage("");
    let saved = false;
    try {
      await mutation();
      saved = true;
      if (version !== requestVersion.current) return false;
      const settings = await getOperaSettings(hotelUid);
      if (version !== requestVersion.current) return false;
      setMappings(normalizeMappings(settings.operaUserMappings));
      setMessage(successMessage);
      return true;
    } catch (error) {
      if (version === requestVersion.current) setError(saved ? "Changes saved, but Opera settings could not be refreshed. Reload settings." : error.message || "Opera settings could not be saved.");
      return version === requestVersion.current && saved;
    } finally {
      if (version === requestVersion.current) setSaving(false);
    }
  };

  const handleAddMapping = async (event) => {
    event.preventDefault();
    if (!canCreateSettings) return;
    const cleanedOperaUser = operaUser.trim();
    const cleanedEmployeeName = employeeName.trim();
    if (!cleanedOperaUser || !cleanedEmployeeName) {
      setError("Enter both an Opera PMS username and an employee name.");
      setMessage("");
      return;
    }
    if (await persistMapping(() => createOperaUserMapping(hotelUid, {
      operaUser: cleanedOperaUser, employeeName: cleanedEmployeeName,
    }), "Opera user mapping created.")) {
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
      setError("Employee name cannot be empty.");
      setMessage("");
      return;
    }
    if (await persistMapping(() => updateOperaUserMapping(hotelUid, editingOperaUser, cleanedEmployeeName), "Opera user mapping updated.")) {
      setEditingOperaUser("");
      setEditingEmployeeName("");
    }
  };

  const handleDelete = async (targetOperaUser) => {
    if (!canDeleteSettings || !targetOperaUser || saving) return;
    if (!window.confirm(`Delete the mapping for ${targetOperaUser}?`)) return;
    await persistMapping(() => deleteOperaUserMapping(hotelUid, targetOperaUser), "Opera user mapping deleted.");
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
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
              <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)} className="ml-3 underline">Reload settings</button>
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
                maxLength={128}
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
                maxLength={200}
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
                            maxLength={200}
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

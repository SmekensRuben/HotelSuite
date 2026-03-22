import React, { useEffect, useMemo, useState } from "react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSettings, setSettings } from "../../services/firebaseSettings";

export default function GeneralSettingsPage() {
  const { hotelUid } = useHotelContext();
  const [hotelRooms, setHotelRooms] = useState("");
  const [lastSavedHotelRooms, setLastSavedHotelRooms] = useState("");
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

    async function loadSettings() {
      if (!hotelUid) {
        setHotelRooms("");
        setLastSavedHotelRooms("");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");
      setMessage("");

      try {
        const settings = await getSettings(hotelUid);
        if (!active) return;
        const nextHotelRooms = settings?.hotelRooms != null ? String(settings.hotelRooms) : "";
        setHotelRooms(nextHotelRooms);
        setLastSavedHotelRooms(nextHotelRooms);
      } catch (err) {
        console.error("Fout bij laden van general settings:", err);
        if (!active) return;
        setError("De general settings konden niet geladen worden.");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    loadSettings();

    return () => {
      active = false;
    };
  }, [hotelUid]);

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  const persistHotelRooms = async () => {
    setError("");
    setMessage("");

    const normalizedHotelRooms = String(hotelRooms).trim();
    const parsedHotelRooms = Number(normalizedHotelRooms);

    if (!Number.isFinite(parsedHotelRooms) || parsedHotelRooms < 0) {
      setError("Hotel Rooms moet een geldig positief getal zijn.");
      return false;
    }

    if (!hotelUid) {
      setError("Geen hotel geselecteerd om Hotel Rooms op te slaan.");
      return false;
    }

    if (normalizedHotelRooms === lastSavedHotelRooms) {
      setMessage("General settings zijn al opgeslagen in Firebase.");
      return true;
    }

    setSaving(true);

    try {
      await setSettings(hotelUid, { hotelRooms: parsedHotelRooms });
      const refreshedSettings = await getSettings(hotelUid);
      const persistedHotelRooms =
        refreshedSettings?.hotelRooms != null ? String(refreshedSettings.hotelRooms) : "";
      setHotelRooms(persistedHotelRooms);
      setLastSavedHotelRooms(persistedHotelRooms);
      setMessage("Hotel Rooms opgeslagen in Firebase.");
      return true;
    } catch (err) {
      console.error("Fout bij opslaan van general settings:", err);
      setError("De general settings konden niet opgeslagen worden in Firebase.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    await persistHotelRooms();
  };

  const handleHotelRoomsBlur = async () => {
    if (String(hotelRooms).trim() === lastSavedHotelRooms) return;
    await persistHotelRooms();
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={todayLabel} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">Settings</p>
          <h1 className="text-3xl font-semibold">General Settings</h1>
        </div>

        <Card className="max-w-2xl space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Hotel configuration</h2>
            <p className="mt-1 text-sm text-gray-600">
              Stel hier algemene hotelinstellingen in die gebruikt worden in rapporten en dashboards.
            </p>
          </div>

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

          {loading ? (
            <div className="text-sm text-gray-500">General settings worden geladen...</div>
          ) : (
            <form className="space-y-5" onSubmit={handleSubmit}>
              <div>
                <label htmlFor="hotel-rooms" className="block text-sm font-semibold text-gray-700">
                  Hotel Rooms
                </label>
                <input
                  id="hotel-rooms"
                  type="number"
                  min="0"
                  step="1"
                  value={hotelRooms}
                  onChange={(event) => setHotelRooms(event.target.value)}
                  onBlur={handleHotelRoomsBlur}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  placeholder="Bijvoorbeeld 120"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Wordt gebruikt om occupancy op de Pick-Up pagina te berekenen en wordt meteen in
                  Firebase bewaard zodra je het veld verlaat of op opslaan klikt.
                </p>
              </div>

              <div>
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? "Opslaan..." : "Opslaan"}
                </button>
              </div>
            </form>
          )}
        </Card>
      </PageContainer>
    </div>
  );
}

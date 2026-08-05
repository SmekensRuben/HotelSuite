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
  const [roomTypes, setRoomTypes] = useState([]);
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
        setRoomTypes([]);
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
        setRoomTypes(Array.isArray(settings?.roomTypes) ? settings.roomTypes.map((roomType, index) => ({
          id: roomType?.id || `${roomType?.code || "room-type"}-${index}`,
          code: String(roomType?.code || ""),
          description: String(roomType?.description || ""),
          amount: roomType?.amount != null ? String(roomType.amount) : "",
        })) : []);
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

  const normalizeRoomTypes = () =>
    roomTypes
      .map((roomType) => {
        const code = String(roomType.code || "").trim();
        const description = String(roomType.description || "").trim();
        const amountValue = String(roomType.amount ?? "").trim();
        const amount = Number(amountValue);
        return {
          id: String(roomType.id || code || crypto.randomUUID()).trim(),
          code,
          description,
          amount: amountValue !== "" && Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : NaN,
        };
      })
      .filter((roomType) => roomType.code || roomType.description || Number.isFinite(roomType.amount));

  const persistGeneralSettings = async () => {
    setError("");
    setMessage("");

    const normalizedHotelRooms = String(hotelRooms).trim();
    const parsedHotelRooms = Number(normalizedHotelRooms);
    const normalizedRoomTypes = normalizeRoomTypes();

    if (!Number.isFinite(parsedHotelRooms) || parsedHotelRooms < 0) {
      setError("Hotel Rooms moet een geldig positief getal zijn.");
      return false;
    }

    const invalidRoomType = normalizedRoomTypes.find((roomType) => !roomType.code || !roomType.description || !Number.isFinite(roomType.amount));
    if (invalidRoomType) {
      setError("Elke Room Type moet een code, description en geldig positief amount hebben.");
      return false;
    }

    if (!hotelUid) {
      setError("Geen hotel geselecteerd om General Settings op te slaan.");
      return false;
    }

    setSaving(true);

    try {
      await setSettings(hotelUid, { hotelRooms: parsedHotelRooms, roomTypes: normalizedRoomTypes });
      const refreshedSettings = await getSettings(hotelUid);
      const persistedHotelRooms =
        refreshedSettings?.hotelRooms != null ? String(refreshedSettings.hotelRooms) : "";
      setHotelRooms(persistedHotelRooms);
      setLastSavedHotelRooms(persistedHotelRooms);
      setRoomTypes(Array.isArray(refreshedSettings?.roomTypes) ? refreshedSettings.roomTypes.map((roomType, index) => ({
        id: roomType?.id || `${roomType?.code || "room-type"}-${index}`,
        code: String(roomType?.code || ""),
        description: String(roomType?.description || ""),
        amount: roomType?.amount != null ? String(roomType.amount) : "",
      })) : []);
      setMessage("General settings opgeslagen in Firebase.");
      return true;
    } catch (err) {
      console.error("Fout bij opslaan van general settings:", err);
      setError("De general settings konden niet opgeslagen worden in Firebase.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const addRoomType = () => {
    setRoomTypes((current) => [...current, { id: `${Date.now()}`, code: "", description: "", amount: "" }]);
  };

  const updateRoomType = (id, field, value) => {
    setRoomTypes((current) =>
      current.map((roomType) => (roomType.id === id ? { ...roomType, [field]: value } : roomType))
    );
  };

  const removeRoomType = (id) => {
    setRoomTypes((current) => current.filter((roomType) => roomType.id !== id));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    await persistGeneralSettings();
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

              <div className="space-y-3 rounded-xl border border-gray-200 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold text-gray-900">Room Types</h3>
                    <p className="text-xs text-gray-500">Deze types worden gebruikt op de Create Group pagina.</p>
                  </div>
                  <button type="button" onClick={addRoomType} className="rounded-lg border border-blue-600 px-3 py-2 text-sm font-semibold text-blue-600 hover:bg-blue-50">
                    Add Room Type
                  </button>
                </div>
                {roomTypes.length === 0 ? (
                  <p className="text-sm text-gray-500">Nog geen Room Types toegevoegd.</p>
                ) : (
                  <div className="space-y-2">
                    {roomTypes.map((roomType) => (
                      <div key={roomType.id} className="grid gap-2 sm:grid-cols-[8rem_1fr_7rem_auto]">
                        <input aria-label="Room type code" value={roomType.code} onChange={(event) => updateRoomType(roomType.id, "code", event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="Code" />
                        <input aria-label="Room type description" value={roomType.description} onChange={(event) => updateRoomType(roomType.id, "description", event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="Description" />
                        <input aria-label="Room type amount" type="number" min="0" step="1" value={roomType.amount} onChange={(event) => updateRoomType(roomType.id, "amount", event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="Amount" />
                        <button type="button" onClick={() => removeRoomType(roomType.id)} className="rounded-lg px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50">Remove</button>
                      </div>
                    ))}
                  </div>
                )}
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

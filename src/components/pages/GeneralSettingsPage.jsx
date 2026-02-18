import React, { useEffect, useMemo, useState } from "react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSettings, setSettings } from "../../services/firebaseSettings";

export default function GeneralSettingsPage() {
  const { hotelUid } = useHotelContext();
  const [breakfastPrice, setBreakfastPrice] = useState("");
  const [hotelRoomCount, setHotelRoomCount] = useState("");
  const [roomVatPercent, setRoomVatPercent] = useState("");
  const [expectedRoomRateYoYIncrease, setExpectedRoomRateYoYIncrease] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const todayLabel = useMemo(
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
    if (!hotelUid) return;
    const loadSettings = async () => {
      setLoading(true);
      const settings = await getSettings(hotelUid);
      setBreakfastPrice(
        settings?.breakfastPrice !== undefined ? String(settings.breakfastPrice) : ""
      );
      setHotelRoomCount(
        settings?.hotelRoomCount !== undefined ? String(settings.hotelRoomCount) : ""
      );
      setRoomVatPercent(
        settings?.roomVatPercent !== undefined ? String(settings.roomVatPercent) : ""
      );
      setExpectedRoomRateYoYIncrease(
        settings?.expectedRoomRateYoYIncrease !== undefined
          ? String(settings.expectedRoomRateYoYIncrease)
          : ""
      );
      setLoading(false);
    };
    loadSettings();
  }, [hotelUid]);

  const handleSave = async () => {
    if (!hotelUid) return;
    setSaving(true);
    setMessage("");
    await setSettings(hotelUid, {
      breakfastPrice: Number(breakfastPrice) || 0,
      hotelRoomCount: Number(hotelRoomCount) || 0,
      roomVatPercent: Number(roomVatPercent) || 0,
      expectedRoomRateYoYIncrease: Number(expectedRoomRateYoYIncrease) || 0,
    });
    setSaving(false);
    setMessage("Settings opgeslagen.");
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={todayLabel} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">Settings</p>
          <h1 className="text-3xl font-semibold">General Settings</h1>
          <p className="text-gray-600 mt-1">
            Beheer de algemene instellingen voor quotes en room rates.
          </p>
        </div>

        <Card>
          {loading ? (
            <p className="text-gray-600">Settings laden...</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
                Breakfast Price
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={breakfastPrice}
                  onChange={(event) => setBreakfastPrice(event.target.value)}
                  className="rounded border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
                Room VAT %
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={roomVatPercent}
                  onChange={(event) => setRoomVatPercent(event.target.value)}
                  className="rounded border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
                Amount of Hotel Rooms
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={hotelRoomCount}
                  onChange={(event) => setHotelRoomCount(event.target.value)}
                  className="rounded border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700 sm:col-span-2">
                Expected Room Rate YoY Increase %
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={expectedRoomRateYoYIncrease}
                  onChange={(event) =>
                    setExpectedRoomRateYoYIncrease(event.target.value)
                  }
                  className="rounded border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
              <div className="flex items-center gap-3 sm:col-span-2">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="bg-[#b41f1f] text-white px-4 py-2 rounded font-semibold shadow hover:bg-[#961919] transition-colors disabled:opacity-60"
                >
                  {saving ? "Opslaan..." : "Settings opslaan"}
                </button>
                {message && <span className="text-sm text-green-600">{message}</span>}
              </div>
            </div>
          )}
        </Card>
      </PageContainer>
    </div>
  );
}

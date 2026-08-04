import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, BedDouble, Plus, Trash2 } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";

const initialRoomTypes = [
  { id: "standard", name: "Standard Room", quantity: 10 },
  { id: "deluxe", name: "Deluxe Room", quantity: 5 },
];

export default function CreateBlockPage() {
  const navigate = useNavigate();
  const [roomTypes, setRoomTypes] = useState(initialRoomTypes);

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

  const addRoomType = () => {
    setRoomTypes((items) => [...items, { id: `room-type-${Date.now()}`, name: "", quantity: 0 }]);
  };

  const updateRoomType = (id, field, value) => {
    setRoomTypes((items) => items.map((item) => (item.id === id ? { ...item, [field]: value } : item)));
  };

  const removeRoomType = (id) => {
    setRoomTypes((items) => items.filter((item) => item.id !== id));
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    navigate("/me/groups");
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-white via-gray-50 to-gray-100 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6 pb-10">
        <Card className="border-0 bg-gradient-to-r from-[#b41f1f] via-[#a71c1c] to-[#7f1717] text-white shadow-lg">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-2">
              <p className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-red-100">
                <BedDouble className="h-3.5 w-3.5" /> M&amp;E block management
              </p>
              <h1 className="text-3xl font-semibold">Create Block</h1>
              <p className="max-w-2xl text-sm text-red-100">
                Capture group details, room allocation, organiser contacts, and rooming list deadlines.
              </p>
            </div>
            <button
              type="button"
              onClick={() => navigate("/me/groups")}
              className="inline-flex items-center gap-2 rounded-lg border border-white/30 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20"
            >
              <ArrowLeft className="h-4 w-4" /> Back to Groups
            </button>
          </div>
        </Card>

        <form onSubmit={handleSubmit} className="grid gap-4 lg:grid-cols-3">
          <Card className="border border-gray-100 bg-white/95 shadow-sm lg:col-span-2">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Group Name" name="groupName" required />
              <Field label="Block Code" name="blockCode" required />
              <Field label="Arrival" name="arrival" type="date" required />
              <Field label="Departure" name="departure" type="date" required />
              <Field label="Rooming List Deadline" name="roomingListDeadline" type="date" required />
              <Field label="Blocked Rooms" name="blockedRooms" type="number" min="0" required />
              <Field label="M&E Officer" name="meOfficer" required />
              <Field label="Organiser Name" name="organiserName" required />
              <Field label="Organiser Email" name="organiserEmail" type="email" required />
              <Field label="Organiser Phone" name="organiserPhone" />
            </div>
          </Card>

          <Card className="border border-gray-100 bg-white/95 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Allowed Room Types</h2>
                <p className="mt-1 text-sm text-gray-600">Add every allowed room type and the quantity in the block.</p>
              </div>
              <button
                type="button"
                onClick={addRoomType}
                className="inline-flex items-center gap-1 rounded-lg border border-[#b41f1f] px-3 py-2 text-sm font-semibold text-[#b41f1f] hover:bg-red-50"
              >
                <Plus className="h-4 w-4" /> Add
              </button>
            </div>

            <div className="mt-4 space-y-3">
              {roomTypes.map((roomType) => (
                <div key={roomType.id} className="grid grid-cols-[1fr_6rem_auto] items-end gap-2">
                  <label className="block text-sm font-medium text-gray-700">
                    Room Type
                    <input
                      type="text"
                      value={roomType.name}
                      onChange={(event) => updateRoomType(roomType.id, "name", event.target.value)}
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
                      placeholder="e.g. Standard Room"
                    />
                  </label>
                  <label className="block text-sm font-medium text-gray-700">
                    Quantity
                    <input
                      type="number"
                      min="0"
                      value={roomType.quantity}
                      onChange={(event) => updateRoomType(roomType.id, "quantity", event.target.value)}
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => removeRoomType(roomType.id)}
                    className="mb-0.5 rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-[#b41f1f]"
                    aria-label={`Remove ${roomType.name || "room type"}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </Card>

          <div className="flex justify-end gap-3 lg:col-span-3">
            <button type="button" onClick={() => navigate("/me/groups")} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100">
              Cancel
            </button>
            <button type="submit" className="rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919]">
              Create Block
            </button>
          </div>
        </form>
      </PageContainer>
    </div>
  );
}

function Field({ label, name, type = "text", ...props }) {
  return (
    <label className="block text-sm font-medium text-gray-700">
      {label}
      <input
        name={name}
        type={type}
        className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
        {...props}
      />
    </label>
  );
}

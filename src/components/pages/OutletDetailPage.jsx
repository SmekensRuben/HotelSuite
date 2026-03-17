import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Pencil } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getOutletApprovers, getOutletById } from "../../services/firebaseSettings";
import { usePermission } from "../../hooks/usePermission";

export default function OutletDetailPage() {
  const navigate = useNavigate();
  const { outletId } = useParams();
  const { hotelUid } = useHotelContext();
  const canEditOutlets = usePermission("settings", "update");
  const [outlet, setOutlet] = useState(null);
  const [approvers, setApprovers] = useState([]);
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

  useEffect(() => {
    const loadOutlet = async () => {
      if (!hotelUid || !outletId) return;
      setLoading(true);
      const [outletData, approverData] = await Promise.all([
        getOutletById(hotelUid, outletId),
        getOutletApprovers(hotelUid, outletId),
      ]);
      setOutlet(outletData);
      setApprovers(approverData);
      setLoading(false);
    };

    loadOutlet();
  }, [hotelUid, outletId]);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-3xl font-semibold">Outlet Detail</h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate("/settings/outlets")}
              className="inline-flex items-center justify-center rounded border border-gray-300 p-2 text-gray-700 hover:bg-gray-100"
              title="Back to outlets"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => navigate(`/settings/outlets/${outletId}/edit`)}
              disabled={!canEditOutlets}
              className={`inline-flex items-center justify-center rounded border p-2 ${
                canEditOutlets
                  ? "border-gray-300 text-gray-700 hover:bg-gray-100"
                  : "border-gray-200 text-gray-400 cursor-not-allowed"
              }`}
              title="Edit outlet"
            >
              <Pencil className="h-4 w-4" />
            </button>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-600">Loading outlet...</p>
        ) : !outlet ? (
          <Card>
            <p className="text-gray-600">Outlet not found.</p>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="lg:col-span-2">
              <h2 className="text-2xl font-semibold">{outlet.name || "-"}</h2>
              <p className="text-gray-600 mt-1">ID: {outlet.id || "-"}</p>
            </Card>

            <Card className="lg:col-span-2">
              <h3 className="text-lg font-semibold mb-2">Approvers</h3>
              {approvers.length === 0 ? (
                <p className="text-sm text-gray-600">No approvers configured.</p>
              ) : (
                <ul className="space-y-2 text-sm text-gray-700">
                  {approvers.map((approver) => {
                    const fullName = `${approver.firstName || ""} ${approver.lastName || ""}`.trim();
                    const label = approver.displayName || fullName || approver.email || approver.id;
                    return (
                      <li key={approver.id} className="rounded border border-gray-200 px-3 py-2">
                        {label} {approver.email ? `(${approver.email})` : ""}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>
        )}
      </PageContainer>
    </div>
  );
}

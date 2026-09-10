import React, { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { subscribeQuotes } from "../../services/firebaseQuotes";

export default function GroupQuotesPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const canCreate = usePermission("groupquotes", "create");
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const today = useMemo(() => new Date().toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric",
  }), []);

  useEffect(() => {
    setLoading(true);
    if (!hotelUid) return undefined;
    return subscribeQuotes(hotelUid, (items) => {
      setQuotes(items);
      setLoading(false);
    });
  }, [hotelUid]);

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  const columns = [
    { key: "name", label: "Name" },
    { key: "requestDate", label: "Request Date" },
    { key: "startDate", label: "Start Date" },
    { key: "endDate", label: "End Date" },
    {
      key: "rooms",
      label: "Rooms",
      sortValue: (quote) => (quote.roomsByDate || []).reduce((sum, item) => sum + Number(item.rooms || 0), 0),
      render: (quote) => (quote.roomsByDate || []).reduce((sum, item) => sum + Number(item.rooms || 0), 0),
    },
    {
      key: "pricePerNight",
      label: "Price / Night",
      sortValue: (quote) => Number(quote.pricePerNight || 0),
      render: (quote) => `€${Number(quote.pricePerNight || 0).toFixed(2)}`,
    },
    { key: "breakfastIncluded", label: "Breakfast Included", render: (quote) => quote.breakfastIncluded ? "Yes" : "No" },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-wide text-gray-500">Revenue</p>
            <h1 className="text-3xl font-semibold">Group Quotes</h1>
            <p className="mt-1 text-gray-600">Manage group accommodation quotes.</p>
          </div>
          {canCreate && (
            <button
              type="button"
              onClick={() => navigate("/revenue/group-quotes/new")}
              className="inline-flex items-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 font-semibold text-white shadow hover:bg-[#961919]"
            >
              <Plus className="h-5 w-5" /> Create Quote
            </button>
          )}
        </div>
        {loading ? <p className="text-gray-600">Loading quotes...</p> : (
          <DataListTable
            columns={columns}
            rows={quotes}
            onRowClick={(quote) => navigate(`/revenue/group-quotes/${quote.id}`)}
            emptyMessage="No group quotes found."
          />
        )}
      </PageContainer>
    </div>
  );
}

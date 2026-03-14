import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getContracts } from "../../services/firebaseContracts";
import { usePermission } from "../../hooks/usePermission";

function isExpired(endDate) {
  if (!endDate) return false;
  const parsed = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return false;

  const today = new Date();
  const todayAtMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return parsed < todayAtMidnight;
}

export default function ContractsPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const canCreateContracts = usePermission("contracts", "create");
  const [contracts, setContracts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");

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
    const loadContracts = async () => {
      if (!hotelUid) return;
      setLoading(true);
      const result = await getContracts(hotelUid);
      setContracts(result);
      setLoading(false);
    };
    loadContracts();
  }, [hotelUid]);

  const filteredContracts = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return contracts.filter((contract) => {
      const name = String(contract.name || "").toLowerCase();
      const category = String(contract.category || "").toLowerCase();
      const expired = isExpired(contract.endDate);
      const matchesFilter = statusFilter === "expired" ? expired : !expired;
      return matchesFilter && (!term || name.includes(term) || category.includes(term));
    });
  }, [contracts, searchTerm, statusFilter]);

  const columns = [
    { key: "name", label: "Name" },
    { key: "category", label: "Category" },
    { key: "startDate", label: "Start Date" },
    { key: "endDate", label: "End Date" },
    { key: "terminationPeriodDays", label: "Termination Period (days)" },
    { key: "cancelBefore", label: "Cancel Before" },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
            <h1 className="text-3xl font-semibold">Contracts</h1>
            <p className="text-gray-600 mt-1">Manage supplier and service contracts.</p>
          </div>
          <button
            onClick={() => navigate("/contracts/new")}
            disabled={!canCreateContracts}
            className={`inline-flex items-center justify-center rounded-lg p-2 shadow ${
              canCreateContracts
                ? "bg-[#b41f1f] text-white hover:bg-[#961919]"
                : "bg-gray-300 text-gray-500 cursor-not-allowed"
            }`}
            title="Create contract"
          >
            <Plus className="h-5 w-5" />
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div>
            <label className="sr-only" htmlFor="contracts-search">
              Search contracts
            </label>
            <input
              id="contracts-search"
              type="text"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search by contract name or category"
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
          >
            <option value="active">Active</option>
            <option value="expired">Expired</option>
          </select>
        </div>

        {loading ? (
          <p className="text-gray-600">Loading contracts...</p>
        ) : (
          <DataListTable
            columns={columns}
            rows={filteredContracts}
            onRowClick={(contract) => navigate(`/contracts/${contract.id}`)}
            emptyMessage="No contracts found."
          />
        )}
      </PageContainer>
    </div>
  );
}

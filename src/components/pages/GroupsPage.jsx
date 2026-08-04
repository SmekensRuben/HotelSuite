import React, { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, UsersRound } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { usePermission } from "../../hooks/usePermission";

const groups = [
  {
    id: "grp-summit-2026",
    groupName: "European Sales Summit",
    blockCode: "ESS26",
    arrival: "2026-09-14",
    roomingListDeadline: "2026-08-24",
    blockedRooms: 42,
    meOfficer: "Maya Jacobs",
  },
  {
    id: "grp-medtech-2026",
    groupName: "MedTech Leadership Forum",
    blockCode: "MTLF26",
    arrival: "2026-10-03",
    roomingListDeadline: "2026-09-12",
    blockedRooms: 28,
    meOfficer: "Liam Peters",
  },
  {
    id: "grp-design-week",
    groupName: "Design Week Delegation",
    blockCode: "DWD26",
    arrival: "2026-11-08",
    roomingListDeadline: "2026-10-18",
    blockedRooms: 35,
    meOfficer: "Sofia Martinez",
  },
];

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}

export default function GroupsPage() {
  const navigate = useNavigate();
  const canCreateGroups = usePermission("groups", "create");

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

  const columns = [
    { key: "groupName", label: "Group Name" },
    { key: "blockCode", label: "Block Code" },
    {
      key: "arrival",
      label: "Arrival",
      render: (row) => formatDate(row.arrival),
    },
    {
      key: "roomingListDeadline",
      label: "Rooming List Deadline",
      render: (row) => formatDate(row.roomingListDeadline),
    },
    {
      key: "blockedRooms",
      label: "Blocked Rooms",
      sortValue: (row) => Number(row.blockedRooms || 0),
    },
    { key: "meOfficer", label: "M&E Officer" },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">M&amp;E</p>
            <h1 className="text-3xl font-semibold">Groups</h1>
            <p className="mt-1 text-gray-600">Review upcoming group blocks and rooming list deadlines.</p>
          </div>
          <button
            onClick={() => navigate("/me/groups/new")}
            disabled={!canCreateGroups}
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow ${
              canCreateGroups
                ? "bg-[#b41f1f] text-white hover:bg-[#961919]"
                : "bg-gray-300 text-gray-500 cursor-not-allowed"
            }`}
          >
            <Plus className="h-4 w-4" /> Create Group
          </button>
        </div>

        <div className="rounded-xl border border-red-100 bg-white p-4 shadow-sm">
          <div className="mb-4 flex items-center gap-3 text-sm text-gray-600">
            <span className="rounded-lg bg-[#b41f1f]/10 p-2 text-[#b41f1f]">
              <UsersRound className="h-5 w-5" />
            </span>
            <span>Use this overview to follow group block status before the rooming list deadline.</span>
          </div>
          <DataListTable columns={columns} rows={groups} emptyMessage="No groups found." />
        </div>
      </PageContainer>
    </div>
  );
}

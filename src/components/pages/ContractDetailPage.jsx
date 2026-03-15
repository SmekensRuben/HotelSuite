import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, BellRing, CalendarClock, Download, Files, Pencil } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getContract } from "../../services/firebaseContracts";
import { usePermission } from "../../hooks/usePermission";

function DetailField({ label, value }) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-sm font-medium text-gray-800">{value || "-"}</p>
    </div>
  );
}

function formatDate(value) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString();
}

export default function ContractDetailPage() {
  const navigate = useNavigate();
  const { contractId } = useParams();
  const { hotelUid } = useHotelContext();
  const canEditContracts = usePermission("contracts", "update");
  const [contract, setContract] = useState(null);
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
    const loadContract = async () => {
      if (!hotelUid || !contractId) return;
      setLoading(true);
      const data = await getContract(hotelUid, contractId);
      setContract(data);
      setLoading(false);
    };
    loadContract();
  }, [hotelUid, contractId]);

  const contractFiles = Array.isArray(contract?.contractFiles)
    ? contract.contractFiles
    : contract?.contractFile
      ? [contract.contractFile]
      : [];

  return (
    <div className="min-h-screen bg-gradient-to-b from-white via-gray-50 to-gray-100 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6 pb-10">
        <Card className="border-0 bg-gradient-to-r from-[#b41f1f] via-[#a71c1c] to-[#7f1717] text-white shadow-lg">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-[0.2em] text-red-100">Contract details</p>
              <h1 className="text-3xl font-semibold">{contract?.name || "Contract information"}</h1>
              <div className="flex flex-wrap gap-2 text-xs text-red-100">
                <span className="rounded-full bg-white/10 px-3 py-1">Category: {contract?.category || "-"}</span>
                <span className="rounded-full bg-white/10 px-3 py-1">Subcategory: {contract?.subcategory || "-"}</span>
                <span className="rounded-full bg-white/10 px-3 py-1">Files: {contractFiles.length}</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => navigate("/contracts")}
                className="inline-flex items-center gap-2 rounded-lg border border-white/30 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20"
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
              <button
                type="button"
                onClick={() => navigate(`/contracts/${contractId}/edit`)}
                disabled={!canEditContracts}
                className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold ${
                  canEditContracts
                    ? "bg-white text-[#b41f1f] hover:bg-red-50"
                    : "cursor-not-allowed bg-white/40 text-white"
                }`}
                title="Edit contract"
              >
                <Pencil className="h-4 w-4" /> Edit
              </button>
            </div>
          </div>
        </Card>

        {loading ? (
          <Card className="border border-gray-100 bg-white/95 shadow-sm">
            <p className="text-gray-600">Loading contract...</p>
          </Card>
        ) : !contract ? (
          <Card className="border border-gray-100 bg-white/95 shadow-sm">
            <p className="text-gray-600">Contract not found.</p>
          </Card>
        ) : (
          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="border border-gray-100 bg-white/95 shadow-sm xl:col-span-2">
              <h2 className="mb-4 text-lg font-semibold">Contract information</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <DetailField label="Start date" value={formatDate(contract.startDate)} />
                <DetailField label="End date" value={formatDate(contract.endDate)} />
                <DetailField label="Category" value={contract.category} />
                <DetailField label="Subcategory" value={contract.subcategory} />
                <DetailField label="Termination period (days)" value={String(contract.terminationPeriodDays ?? "-")} />
                <DetailField label="Cancel before" value={formatDate(contract.cancelBefore)} />
              </div>
            </Card>

            <Card className="border border-gray-100 bg-white/95 shadow-sm">
              <h2 className="mb-4 text-lg font-semibold">Notifications</h2>
              <div className="space-y-2">
                <p className="inline-flex items-center gap-2 text-sm text-gray-700">
                  <BellRing className="h-4 w-4 text-[#b41f1f]" />
                  Reminders: {Array.isArray(contract.reminderDays) ? contract.reminderDays.join(", ") : "-"}
                </p>
                <p className="inline-flex items-center gap-2 text-sm text-gray-700">
                  <CalendarClock className="h-4 w-4 text-[#b41f1f]" />
                  Next action based on end date
                </p>
              </div>
            </Card>

            <Card className="border border-gray-100 bg-white/95 shadow-sm">
              <h2 className="mb-4 text-lg font-semibold">Followers</h2>
              {Array.isArray(contract.followers) && contract.followers.length > 0 ? (
                <ul className="space-y-2">
                  {contract.followers.map((follower) => (
                    <li
                      key={follower.id}
                      className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-sm text-gray-700"
                    >
                      {follower.name || follower.email || follower.id}
                      <span className="block text-xs text-gray-500">{follower.email || "no-email"}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-gray-500">No followers assigned.</p>
              )}
            </Card>

            <Card className="border border-gray-100 bg-white/95 shadow-sm xl:col-span-2">
              <h2 className="mb-4 inline-flex items-center gap-2 text-lg font-semibold">
                <Files className="h-5 w-5 text-[#b41f1f]" /> Documents
              </h2>
              {contractFiles.length > 0 ? (
                <ul className="space-y-2">
                  {contractFiles.map((file, index) => (
                    <li
                      key={`${file.filePath || file.downloadUrl || file.fileName}-${index}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2"
                    >
                      <span className="truncate text-sm text-gray-700">{file.fileName || `Document ${index + 1}`}</span>
                      <a
                        href={file.downloadUrl}
                        download={file.fileName || true}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-2 rounded-lg bg-[#b41f1f] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#961919]"
                      >
                        <Download className="h-4 w-4" /> Download
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-gray-500">No documents uploaded.</p>
              )}
            </Card>
          </div>
        )}
      </PageContainer>
    </div>
  );
}

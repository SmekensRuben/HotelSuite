import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Download, Pencil } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getContract } from "../../services/firebaseContracts";
import { usePermission } from "../../hooks/usePermission";

function DetailField({ label, value }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-sm text-gray-800 mt-1">{value || "-"}</p>
    </div>
  );
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

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-100 to-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
            <h1 className="text-3xl font-semibold">Contract Detail</h1>
          </div>
          <button
            type="button"
            onClick={() => navigate(`/contracts/${contractId}/edit`)}
            disabled={!canEditContracts}
            className={`inline-flex items-center justify-center rounded border p-2 ${
              canEditContracts
                ? "border-gray-300 text-gray-700 hover:bg-gray-100"
                : "border-gray-200 text-gray-400 cursor-not-allowed"
            }`}
            title="Edit contract"
          >
            <Pencil className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <p className="text-gray-600">Loading contract...</p>
        ) : !contract ? (
          <Card>
            <p className="text-gray-600">Contract not found.</p>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="lg:col-span-2">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-semibold text-gray-900">{contract.name || "-"}</h2>
                  <p className="text-gray-600 mt-1">Category: {contract.category || "-"}</p>
                </div>
                {contract.contractFile?.downloadUrl ? (
                  <a
                    href={contract.contractFile.downloadUrl}
                    download={contract.contractFile.fileName || true}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white hover:bg-[#961919]"
                  >
                    <Download className="h-4 w-4" /> Download file
                  </a>
                ) : null}
              </div>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold mb-3">Contract Information</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <DetailField label="Start Date" value={contract.startDate} />
                <DetailField label="End Date" value={contract.endDate} />
                <DetailField
                  label="Termination Period (days)"
                  value={String(contract.terminationPeriodDays ?? "")}
                />
                <DetailField label="Cancel Before" value={contract.cancelBefore} />
                <DetailField
                  label="Reminder Days"
                  value={Array.isArray(contract.reminderDays) ? contract.reminderDays.join(", ") : ""}
                />
                <DetailField label="File" value={contract.contractFile?.fileName} />
              </div>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold mb-3">Followers</h2>
              {Array.isArray(contract.followers) && contract.followers.length > 0 ? (
                <ul className="space-y-2">
                  {contract.followers.map((follower) => (
                    <li key={follower.id} className="text-sm text-gray-700">
                      {follower.name || follower.email || follower.id} ({follower.email || "no-email"})
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-gray-500">No followers assigned.</p>
              )}
            </Card>
          </div>
        )}
      </PageContainer>
    </div>
  );
}

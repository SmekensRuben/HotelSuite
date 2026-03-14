import React, { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Download } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getContract } from "../../services/firebaseContracts";

function DetailField({ label, value }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-sm text-gray-800 mt-1">{value || "-"}</p>
    </div>
  );
}

export default function ContractDetailPage() {
  const { contractId } = useParams();
  const { hotelUid } = useHotelContext();
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
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
          <h1 className="text-3xl font-semibold">Contract Detail</h1>
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
                <DetailField label="Termination Period" value={contract.terminationPeriod} />
                <DetailField label="File" value={contract.contractFile?.fileName} />
              </div>
            </Card>
          </div>
        )}
      </PageContainer>
    </div>
  );
}

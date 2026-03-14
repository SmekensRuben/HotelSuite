import React, { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import ContractFormFields from "./ContractFormFields";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createContract } from "../../services/firebaseContracts";

export default function ContractCreatePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();

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

  const handleCreate = async (payload, contractFile) => {
    const actor = auth.currentUser?.uid || "unknown";
    const contractId = await createContract(hotelUid, payload, contractFile, actor);
    navigate(`/contracts/${contractId}`);
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
          <h1 className="text-3xl font-semibold">Add Contract</h1>
        </div>

        <Card>
          <ContractFormFields
            onSubmit={handleCreate}
            savingLabel="Creating contract..."
            submitLabel="Create Contract"
          />
        </Card>
      </PageContainer>
    </div>
  );
}

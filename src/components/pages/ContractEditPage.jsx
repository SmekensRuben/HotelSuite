import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import ContractFormFields from "./ContractFormFields";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getContract, updateContract } from "../../services/firebaseContracts";
import { getAllUsers } from "../../services/firebaseUserManagement";

function isUserInHotel(user, hotelUid) {
  const hotelUids = Array.isArray(user?.hotelUid) ? user.hotelUid : user?.hotelUid ? [user.hotelUid] : [];
  return hotelUids.includes(hotelUid);
}

export default function ContractEditPage() {
  const navigate = useNavigate();
  const { contractId } = useParams();
  const { hotelUid } = useHotelContext();
  const [users, setUsers] = useState([]);
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
    const loadData = async () => {
      if (!hotelUid || !contractId) return;
      setLoading(true);
      const [contractData, allUsers] = await Promise.all([getContract(hotelUid, contractId), getAllUsers()]);
      setContract(contractData);
      setUsers(allUsers.filter((user) => isUserInHotel(user, hotelUid)));
      setLoading(false);
    };

    loadData();
  }, [hotelUid, contractId]);

  const handleUpdate = async (payload, contractFiles, remainingFiles) => {
    const actor = auth.currentUser?.uid || "unknown";
    await updateContract(hotelUid, contractId, payload, contractFiles, remainingFiles, actor);
    navigate(`/contracts/${contractId}`);
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
          <h1 className="text-3xl font-semibold">Edit Contract</h1>
        </div>

        {loading ? (
          <p className="text-gray-600">Loading contract...</p>
        ) : !contract ? (
          <Card>
            <p className="text-gray-600">Contract not found.</p>
          </Card>
        ) : (
          <Card>
            <ContractFormFields
              onSubmit={handleUpdate}
              savingLabel="Saving contract..."
              submitLabel="Save Contract"
              initialValues={contract}
              availableUsers={users}
            />
          </Card>
        )}
      </PageContainer>
    </div>
  );
}

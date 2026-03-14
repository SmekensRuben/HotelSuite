import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, FileText, Sparkles } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import ContractFormFields from "./ContractFormFields";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createContract } from "../../services/firebaseContracts";
import { getAllUsers } from "../../services/firebaseUserManagement";

function isUserInHotel(user, hotelUid) {
  const hotelUids = Array.isArray(user?.hotelUid) ? user.hotelUid : user?.hotelUid ? [user.hotelUid] : [];
  return hotelUids.includes(hotelUid);
}

export default function ContractCreatePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [users, setUsers] = useState([]);

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
    const loadUsers = async () => {
      if (!hotelUid) return;
      const allUsers = await getAllUsers();
      setUsers(allUsers.filter((user) => isUserInHotel(user, hotelUid)));
    };

    loadUsers();
  }, [hotelUid]);

  const handleCreate = async (payload, contractFile) => {
    const actor = auth.currentUser?.uid || "unknown";
    const contractId = await createContract(hotelUid, payload, contractFile, actor);
    navigate(`/contracts/${contractId}`);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-white via-gray-50 to-gray-100 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6 pb-10">
        <Card className="border-0 bg-gradient-to-r from-[#b41f1f] via-[#a71c1c] to-[#7f1717] text-white shadow-lg">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-2">
              <p className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-red-100">
                <Sparkles className="h-3.5 w-3.5" /> Contract management
              </p>
              <h1 className="text-3xl font-semibold">Create new contract</h1>
              <p className="max-w-2xl text-sm text-red-100">
                Add contract details, documents, and followers in one clear form.
              </p>
            </div>
            <button
              type="button"
              onClick={() => navigate("/contracts")}
              className="inline-flex items-center gap-2 rounded-lg border border-white/30 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20"
            >
              <ArrowLeft className="h-4 w-4" /> Back to overview
            </button>
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="border border-gray-100 bg-white/90 shadow-sm lg:col-span-1">
            <div className="flex items-start gap-3">
              <div className="rounded-lg bg-[#b41f1f]/10 p-2 text-[#b41f1f]">
                <FileText className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Tip</h2>
                <p className="mt-1 text-sm text-gray-600">
                  You can add multiple documents. After saving, you will go straight to the detail page.
                </p>
              </div>
            </div>
          </Card>

          <Card className="border border-gray-100 bg-white/95 shadow-sm lg:col-span-2">
            <ContractFormFields
              onSubmit={handleCreate}
              savingLabel="Creating contract..."
              submitLabel="Create Contract"
              availableUsers={users}
            />
          </Card>
        </div>
      </PageContainer>
    </div>
  );
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSupplierOutletAccounts, updateSupplierOutletAccount } from "../../services/firebaseSuppliers";
import { useVerifiedRefresh } from "../../hooks/useVerifiedRefresh";
import AsyncError from "../shared/AsyncError";
import { usePermission } from "../../hooks/usePermission";
import Modal from "../shared/Modal";

export default function SupplierOutletAccountsPage() {
  const navigate = useNavigate();
  const { supplierId } = useParams();
  const { hotelUid } = useHotelContext();
  return <AccountList key={`${hotelUid}:${supplierId}:${auth.currentUser?.uid}`} hotelUid={hotelUid} supplierId={supplierId} navigate={navigate} />;
}

function AccountList({ hotelUid, supplierId, navigate }) {
  const actor = auth.currentUser;
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [editor, setEditor] = useState(null), [accountNumber, setAccountNumber] = useState("");
  const [saving, setSaving] = useState(false), [saveError, setSaveError] = useState(null);
  const [uncertain, setUncertain] = useState(false), [message, setMessage] = useState(null);
  useEffect(() => { setEditor(null); setSaveError(null); setMessage(null); setUncertain(false); setSaving(false); }, [actor]);
  const load = useCallback(() => getSupplierOutletAccounts(hotelUid, { supplierId }), [hotelUid, supplierId]);
  const query = useVerifiedRefresh({ scopeKey: `${hotelUid}:${supplierId}`, enabled: Boolean(hotelUid && supplierId), load });
  const accounts = query.data || [];
  const loading = query.loading;
  const canManage = usePermission("suppliers", "update");
  const edit = (account) => {
    if (!canManage || loading || saving) return;
    setEditor({ account, actor }); setAccountNumber(account.accountNumber || "");
    setSaveError(null); setMessage(null); setUncertain(false);
  };
  const close = () => { if (!saving) { setEditor(null); setSaveError(null); setUncertain(false); } };
  const reload = async () => { close(); setMessage(null); await query.retry(); };
  const save = async (event) => {
    event.preventDefault();
    if (!canManage || !editor || editor.actor !== actor || saving || !accountNumber.trim()) return;
    setSaving(true); setSaveError(null);
    const current = () => mounted.current && auth.currentUser === actor;
    try {
      await updateSupplierOutletAccount(hotelUid, editor.account, accountNumber.trim());
      if (!current()) return;
      setEditor(null); setUncertain(false);
      const fresh = await query.retry();
      if (current() && fresh) setMessage("Account number saved. The latest account list has been reloaded.");
    } catch (error) {
      if (current()) {
        setSaveError(error);
        setUncertain(!["invalid-argument", "permission-denied", "unauthenticated", "aborted", "already-exists", "not-found", "failed-precondition"].includes(String(error.code || "").replace(/^functions\//, "")));
      }
    } finally { if (current()) setSaving(false); }
  };

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
    { key: "supplierName", label: "Supplier", render: (row) => row.supplierName || row.supplierId || "-" },
    { key: "outlet", label: "Outlet", render: (row) => row.outletName || row.outletId || "-" },
    { key: "accountNumber", label: "Account Number" },
    ...(canManage ? [{ key: "actions", label: "", render: (row) => <button type="button" disabled={loading || saving} onClick={() => edit(row)} className="ht-button-secondary" aria-label={`Edit account for ${row.outletName || row.outletId}`}>Edit</button> }] : []),
  ];

  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <ProcurementPage className="space-y-6">
        <AsyncError error={query.error} onRetry={query.retry} label="Could not load supplier outlet accounts." />
        {message && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900">{message}</p>}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
            <h1 className="text-3xl font-semibold">Supplier Outlet Accounts</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(`/catalog/suppliers/${supplierId}`)}
              className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Back
            </button>
            <button
              type="button"
              disabled={!canManage}
              onClick={() => navigate(`/catalog/suppliers/${supplierId}/outlet-accounts/new`)}
              className="inline-flex h-10 items-center justify-center rounded-lg bg-brand-800 px-4 text-sm font-medium text-white hover:bg-brand-950 disabled:opacity-50"
            >
              <Plus className="mr-2 h-4 w-4" /> New account
            </button>
          </div>
        </div>

        {loading && !query.data ? (
          <p className="text-gray-600">Loading supplier outlet accounts...</p>
        ) : query.error ? null : (
          <div aria-busy={loading}>{query.refreshing && <p role="status" className="mb-3 text-sm text-gray-600">Refreshing supplier accounts…</p>}<DataListTable columns={columns} rows={accounts} emptyMessage="No supplier outlet accounts found." /></div>
        )}
        <Modal open={Boolean(editor && editor.actor === actor && canManage)} onClose={close} title="Edit supplier outlet account">
          {editor && <form onSubmit={save} className="space-y-4">
            <dl className="grid gap-3 rounded-xl bg-slate-50 p-3 text-sm"><div><dt className="text-slate-500">Supplier</dt><dd className="font-medium">{editor.account.supplierName || editor.account.supplierId}</dd></div><div><dt className="text-slate-500">Outlet</dt><dd className="font-medium">{editor.account.outletName || editor.account.outletId}</dd></div></dl>
            <label className="block text-sm font-medium">Account number<input autoFocus required maxLength={100} disabled={saving || uncertain} value={accountNumber} onChange={(event) => setAccountNumber(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-brand-700 focus:ring-2 focus:ring-brand-100" /></label>
            <p className="text-sm text-slate-600">Used when creating or confirming orders for this supplier and outlet. Sent orders retain their saved account numbers.</p>
            <AsyncError error={saveError} label="Could not verify the account change." />
            {uncertain && <p className="text-sm text-amber-900">The response was not verified. Retry the same change safely, or reload the list to check the latest account number.</p>}
            <div className="flex flex-wrap justify-end gap-2"><button type="button" disabled={saving} onClick={saveError ? reload : close} className="ht-button-secondary">{saveError ? "Reload account list" : "Cancel"}</button><button type="submit" disabled={saving || !accountNumber.trim() || Boolean(saveError && !uncertain && String(saveError.code || "").endsWith("aborted"))} className="ht-button-primary">{saving ? "Saving…" : uncertain ? "Retry same change" : "Save account number"}</button></div>
          </form>}
        </Modal>
      </ProcurementPage>
    </div>
  );
}

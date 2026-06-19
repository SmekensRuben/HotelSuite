import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, CheckCircle2, XCircle } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getAuditUpsell, updateAuditUpsellValidation } from "../../services/firebaseUpsells";
import { getSettings } from "../../services/firebaseSettings";
import Modal from "../shared/Modal";

function toNumericPrice(value) {
  if (value === "" || value === null || value === undefined) return null;
  if (typeof value === "number") return value;

  const numericValue = Number(
    String(value)
      .trim()
      .replace(/[^\d,.-]/g, "")
      .replace(",", ".")
  );
  return Number.isNaN(numericValue) ? null : numericValue;
}

function formatCurrency(value) {
  const numericValue = toNumericPrice(value);
  if (numericValue === null) return value ?? "—";

  return new Intl.NumberFormat("nl-BE", {
    style: "currency",
    currency: "EUR",
  }).format(numericValue);
}

function formatCompactEuro(value) {
  const numericValue = toNumericPrice(value);
  if (numericValue === null) return "—";

  return `€${new Intl.NumberFormat("nl-BE", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(numericValue)}`;
}

function isValidationFinalStatus(status) {
  return ["approved", "rejected", "validated"].includes(String(status || "").toLowerCase());
}

function parseDateKey(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) return null;

  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

function getNights(record) {
  const startDate = parseDateKey(record?.startDate);
  const endDate = parseDateKey(record?.endDate);
  if (!startDate || !endDate || startDate > endDate) return "—";

  return Math.round((endDate - startDate) / (24 * 60 * 60 * 1000)) + 1;
}

function getExpectedRevenue(record) {
  if (Array.isArray(record?.packages) && record.packages.length) {
    return record.packages.reduce((sum, packageRecord) => {
      const startDate = parseDateKey(packageRecord?.startDate);
      const endDate = parseDateKey(packageRecord?.endDate);
      const price = toNumericPrice(packageRecord?.price);
      if (!startDate || !endDate || startDate > endDate || price === null) return sum;

      const nights = Math.round((endDate - startDate) / (24 * 60 * 60 * 1000)) + 1;
      return sum + price * nights;
    }, 0);
  }

  const nights = getNights(record);
  const price = toNumericPrice(record?.price);
  if (nights === "—" || price === null) return null;

  return price * nights;
}

function normalizeOperaUserMappings(rawMappings) {
  if (!rawMappings || typeof rawMappings !== "object") return {};

  return Object.entries(rawMappings).reduce((accumulator, [operaUser, employeeName]) => {
    const cleanedOperaUser = String(operaUser || "").trim();
    const cleanedEmployeeName = String(employeeName || "").trim();

    if (cleanedOperaUser && cleanedEmployeeName) {
      accumulator[cleanedOperaUser] = cleanedEmployeeName;
      accumulator[cleanedOperaUser.toLowerCase()] = cleanedEmployeeName;
    }

    return accumulator;
  }, {});
}

function getMappedOperaUser(operaUser, mappings) {
  const normalizedOperaUser = String(operaUser || "").trim();
  return mappings[normalizedOperaUser] || mappings[normalizedOperaUser.toLowerCase()] || normalizedOperaUser || "—";
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}


function getAuditUpsellPackageRows(record) {
  const packages = Array.isArray(record?.packages) ? record.packages : [];

  if (packages.length) {
    return packages.map((packageRecord, index) => ({
      id: `${packageRecord?.packageCode || "package"}-${packageRecord?.startDate || "start"}-${packageRecord?.endDate || "end"}-${index}`,
      packageCode: packageRecord?.packageCode,
      startDate: packageRecord?.startDate,
      endDate: packageRecord?.endDate,
      price: packageRecord?.price,
      logDate: packageRecord?.logDate || record?.logDate || record?.dateKey,
      logTime: packageRecord?.logTime || record?.logTime,
    }));
  }

  return [
    {
      id: "legacy-package",
      packageCode: record?.packageCode,
      startDate: record?.startDate,
      endDate: record?.endDate,
      price: record?.price,
      logDate: record?.logDate || record?.dateKey,
      logTime: record?.logTime,
    },
  ];
}

function statusBadgeClass(status) {
  const normalizedStatus = String(status || "").toLowerCase();
  if (["linked", "valid", "validated", "approved"].includes(normalizedStatus)) {
    return "border-green-200 bg-green-50 text-green-700";
  }
  if (["pending", "created", "open"].includes(normalizedStatus)) {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  if (["failed", "invalid", "rejected"].includes(normalizedStatus)) {
    return "border-red-200 bg-red-50 text-red-700";
  }
  return "border-gray-200 bg-gray-50 text-gray-700";
}

function getCurrentUserPayload(user) {
  if (!user) return null;

  return {
    uid: user.uid || null,
    email: user.email || null,
    displayName: user.displayName || null,
  };
}

function Badge({ children, className = "" }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${className}`}>
      {children}
    </span>
  );
}

function InfoCard({ title, children, className = "" }) {
  return (
    <section className={`rounded-xl border border-gray-200 bg-white p-5 shadow-sm ${className}`}>
      <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function DetailGrid({ items, subtle = false }) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className={subtle ? "rounded-lg border border-gray-100 bg-white p-3" : "rounded-lg bg-gray-50 p-3"}>
          <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">{item.label}</dt>
          <dd className="mt-1 text-sm font-medium text-gray-900">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function UpsellDetailPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { date, auditUpsellId } = useParams();
  const { hotelUid } = useHotelContext();
  const [auditUpsell, setAuditUpsell] = useState(null);
  const [operaUserMappings, setOperaUserMappings] = useState({});
  const [loading, setLoading] = useState(true);
  const [savingAction, setSavingAction] = useState("");
  const [validationModalAction, setValidationModalAction] = useState("");
  const [validationComment, setValidationComment] = useState("");
  const [effectiveRevenueInput, setEffectiveRevenueInput] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const today = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    []
  );

  useEffect(() => {
    let active = true;

    async function loadAuditUpsell() {
      if (!hotelUid || !date || !auditUpsellId) {
        setLoading(false);
        setError("Audit upsell could not be loaded.");
        return;
      }

      setLoading(true);
      setError("");
      setMessage("");

      try {
        const [record, settings] = await Promise.all([
          getAuditUpsell(hotelUid, date, auditUpsellId),
          getSettings(hotelUid),
        ]);
        if (!active) return;
        setAuditUpsell(record);
        setOperaUserMappings(normalizeOperaUserMappings(settings?.operaUserMappings));
      } catch (err) {
        console.error("Failed to load audit upsell detail", err);
        if (!active) return;
        setError("Audit upsell detail could not be loaded.");
      } finally {
        if (active) setLoading(false);
      }
    }

    loadAuditUpsell();

    return () => {
      active = false;
    };
  }, [auditUpsellId, date, hotelUid]);

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  const openValidationModal = (validationStatus) => {
    if (isValidationFinalStatus(auditUpsell?.validationStatus)) return;

    setValidationModalAction(validationStatus);
    setValidationComment("");
    setEffectiveRevenueInput(
      validationStatus === "approved" && expectedRevenue !== null ? String(expectedRevenue.toFixed(2)) : ""
    );
    setError("");
    setMessage("");
  };

  const closeValidationModal = () => {
    if (savingAction) return;
    setValidationModalAction("");
    setValidationComment("");
    setEffectiveRevenueInput("");
  };

  const handleValidationSubmit = async (event) => {
    event.preventDefault();

    const cleanedComment = validationComment.trim();
    if (!cleanedComment) {
      setError("A comment is required to validate or reject this upsell.");
      return;
    }

    const effectiveRevenue =
      validationModalAction === "approved" ? toNumericPrice(effectiveRevenueInput) : undefined;
    if (validationModalAction === "approved" && effectiveRevenue === null) {
      setError("Enter a valid effective revenue.");
      return;
    }

    setSavingAction(validationModalAction);
    setError("");
    setMessage("");

    try {
      await updateAuditUpsellValidation(
        hotelUid,
        date,
        auditUpsellId,
        validationModalAction,
        cleanedComment,
        getCurrentUserPayload(auth.currentUser),
        effectiveRevenue
      );
      const refreshedRecord = await getAuditUpsell(hotelUid, date, auditUpsellId);
      setAuditUpsell(refreshedRecord);
      setMessage(validationModalAction === "approved" ? "Upsell was validated." : "Upsell was rejected.");
      closeValidationModal();
    } catch (err) {
      console.error("Failed to update audit upsell validation", err);
      setError("The validation status could not be saved.");
    } finally {
      setSavingAction("");
    }
  };

  const mappedOperaUser = getMappedOperaUser(auditUpsell?.operaUser, operaUserMappings);
  const nights = getNights(auditUpsell);
  const expectedRevenue = getExpectedRevenue(auditUpsell);
  const validationStatus = String(auditUpsell?.validationStatus || "").toLowerCase();
  const isValidationLocked = isValidationFinalStatus(validationStatus);
  const effectiveRevenue =
    validationStatus === "approved" || validationStatus === "validated"
      ? toNumericPrice(auditUpsell?.effectiveRevenue) ?? expectedRevenue
      : null;
  const validatedRevenueLabel =
    effectiveRevenue !== null && expectedRevenue !== null
      ? `${formatCompactEuro(effectiveRevenue)}/${formatCompactEuro(expectedRevenue)} Validated`
      : null;
  const detailedFolios = Array.isArray(auditUpsell?.detailedFolios) ? auditUpsell.detailedFolios : [];
  const packageRows = getAuditUpsellPackageRows(auditUpsell);
  const backToAudit = Boolean(location.state?.fromUpsellAudit);
  const backPath = backToAudit
    ? `/front-office/upselling/audit${location.state?.auditSearch || ""}`
    : "/front-office/upselling";
  const backLabel = backToAudit ? "Back to Upsell Audit" : "Back to Upselling";

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <button
          type="button"
          onClick={() => navigate(backPath)}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
        >
          <ArrowLeft className="h-4 w-4" /> {backLabel}
        </button>

        {loading ? (
          <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">
            Loading audit upsell detail...
          </div>
        ) : error && !auditUpsell ? (
          <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>
        ) : !auditUpsell ? (
          <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">
            Audit upsell record was not found.
          </div>
        ) : (
          <>
            <header className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-sm uppercase tracking-wide text-gray-500">Upsell Detail</p>
                  <h1 className="mt-2 text-3xl font-semibold text-gray-900">
                    {formatValue(auditUpsell.fullName)}
                    {auditUpsell.roomNumber ? ` (${auditUpsell.roomNumber})` : ""}
                  </h1>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Badge className="border-blue-200 bg-blue-50 text-blue-700">{formatValue(auditUpsell.packageCode)}</Badge>
                    <Badge className={statusBadgeClass(auditUpsell.validationStatus)}>
                      Validation: {formatValue(auditUpsell.validationStatus)}
                    </Badge>
                    {validatedRevenueLabel && (
                      <Badge className="border-green-200 bg-green-50 text-green-700">
                        {validatedRevenueLabel}
                      </Badge>
                    )}
                    <Badge className={statusBadgeClass(auditUpsell.folioLinkStatus)}>
                      Folio: {formatValue(auditUpsell.folioLinkStatus)}
                    </Badge>
                  </div>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => openValidationModal("approved")}
                    disabled={Boolean(savingAction) || isValidationLocked}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    {savingAction === "approved" ? "Validating..." : "Validate Upsell"}
                  </button>
                  <button
                    type="button"
                    onClick={() => openValidationModal("rejected")}
                    disabled={Boolean(savingAction) || isValidationLocked}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 shadow-sm hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <XCircle className="h-4 w-4" />
                    {savingAction === "rejected" ? "Rejecting..." : "Reject Upsell"}
                  </button>
                </div>
              </div>

              <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                {[
                  { label: "Opera User", value: mappedOperaUser },
                  { label: "Package Code", value: formatValue(auditUpsell.packageCode) },
                  { label: "Package Price", value: formatCurrency(auditUpsell.price) },
                  { label: "Nights", value: nights },
                  { label: "Expected Revenue", value: formatCurrency(expectedRevenue) },
                  ...(validatedRevenueLabel
                    ? [{ label: "Validated Revenue", value: validatedRevenueLabel }]
                    : []),
                ].map((item) => (
                  <div key={item.label} className="border-l border-gray-200 pl-3 first:border-l-0 first:pl-0 sm:first:border-l sm:first:pl-3 lg:first:border-l-0 lg:first:pl-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{item.label}</p>
                    <p className="mt-1 text-sm font-semibold text-gray-900">{item.value}</p>
                  </div>
                ))}
              </div>

            </header>

            {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
            {message && <div className="rounded-lg bg-green-50 p-3 text-sm text-green-700">{message}</div>}

            <section className="space-y-4">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">Detailed folios</h2>
                <p className="mt-1 text-sm text-gray-600">Folio transactions are the main evidence for this upsell review.</p>
              </div>

              {detailedFolios.length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
                  No detailed folio has been linked yet.
                </div>
              ) : (
                detailedFolios.map((folio, index) => {
                  const transactions = Array.isArray(folio?.transactions) ? folio.transactions : [];
                  return (
                    <InfoCard key={`${folio?.billNumber || "folio"}-${index}`} title={`Folio ${formatValue(folio?.billNumber)}`}>
                      <div className="overflow-x-auto rounded-lg border border-gray-200">
                        <table className="min-w-full divide-y divide-gray-200">
                          <thead className="bg-gray-50">
                            <tr>
                              {["Transaction date", "Code", "Description", "Debit", "Credit", "Transaction #"].map((heading) => (
                                <th key={heading} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                                  {heading}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100 bg-white">
                            {transactions.length === 0 ? (
                              <tr>
                                <td colSpan={6} className="px-4 py-6 text-sm text-gray-500">
                                  No transactions found for this folio.
                                </td>
                              </tr>
                            ) : (
                              transactions.map((transaction, transactionIndex) => (
                                <tr key={`${transaction?.transactionNumber || "transaction"}-${transactionIndex}`}>
                                  <td className="px-4 py-3 text-sm text-gray-700">{formatValue(transaction?.transactionDate)}</td>
                                  <td className="px-4 py-3 text-sm text-gray-700">{formatValue(transaction?.transactionCode)}</td>
                                  <td className="px-4 py-3 text-sm text-gray-700">{formatValue(transaction?.description)}</td>
                                  <td className="px-4 py-3 text-sm text-gray-700">{formatCurrency(transaction?.debit)}</td>
                                  <td className="px-4 py-3 text-sm text-gray-700">{formatCurrency(transaction?.credit)}</td>
                                  <td className="px-4 py-3 text-sm text-gray-700">{formatValue(transaction?.transactionNumber)}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </InfoCard>
                  );
                })
              )}
            </section>


            <section className="space-y-4">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">Packages</h2>
                <p className="mt-1 text-sm text-gray-600">All packages included in this audit upsell record.</p>
              </div>

              <InfoCard title="Audit upsell packages">
                <div className="overflow-x-auto rounded-lg border border-gray-200">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        {["Package", "Start date", "End date", "Price", "Log date", "Log time"].map((heading) => (
                          <th key={heading} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                            {heading}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white">
                      {packageRows.map((packageRecord) => (
                        <tr key={packageRecord.id}>
                          <td className="px-4 py-3 text-sm font-medium text-gray-900">{formatValue(packageRecord.packageCode)}</td>
                          <td className="px-4 py-3 text-sm text-gray-700">{formatValue(packageRecord.startDate)}</td>
                          <td className="px-4 py-3 text-sm text-gray-700">{formatValue(packageRecord.endDate)}</td>
                          <td className="px-4 py-3 text-sm text-gray-700">{formatCurrency(packageRecord.price)}</td>
                          <td className="px-4 py-3 text-sm text-gray-700">{formatValue(packageRecord.logDate)}</td>
                          <td className="px-4 py-3 text-sm text-gray-700">{formatValue(packageRecord.logTime)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </InfoCard>
            </section>

            <details className="rounded-xl border border-gray-200 bg-white/70 p-5 shadow-sm">
              <summary className="cursor-pointer text-base font-semibold text-gray-800">Audit details</summary>
              <div className="mt-4">
                <DetailGrid
                  subtle
                  items={[
                    { label: "Package start date", value: formatValue(auditUpsell.startDate) },
                    { label: "Package end date", value: formatValue(auditUpsell.endDate) },
                    { label: "Log date", value: formatValue(auditUpsell.logDate || auditUpsell.dateKey) },
                    { label: "Log time", value: formatValue(auditUpsell.logTime) },
                    { label: "Raw opera user", value: formatValue(auditUpsell.operaUser) },
                    { label: "Mapped opera user", value: mappedOperaUser },
                    { label: "Package code", value: formatValue(auditUpsell.packageCode) },
                    { label: "Price", value: formatCurrency(auditUpsell.price) },
                    { label: "Validation comment", value: formatValue(auditUpsell.validationComment) },
                    { label: "Effective revenue", value: formatCurrency(auditUpsell.effectiveRevenue) },
                  ]}
                />
              </div>
            </details>
          </>
        )}
      </PageContainer>
      <Modal
        open={Boolean(validationModalAction)}
        onClose={closeValidationModal}
        title={validationModalAction === "approved" ? "Validate Upsell" : "Reject Upsell"}
      >
        <form onSubmit={handleValidationSubmit} className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
          {validationModalAction === "approved" && (
            <div className="grid gap-3 rounded-lg bg-gray-50 p-3 sm:grid-cols-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Expected Revenue</p>
                <p className="mt-1 text-sm font-semibold text-gray-900">{formatCurrency(expectedRevenue)}</p>
              </div>
              <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Effective Revenue
                <input
                  type="number"
                  step="0.01"
                  value={effectiveRevenueInput}
                  onChange={(event) => setEffectiveRevenueInput(event.target.value)}
                  className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </label>
            </div>
          )}
          <label className="block text-sm font-medium text-gray-700">
            Comment
            <textarea
              value={validationComment}
              onChange={(event) => setValidationComment(event.target.value)}
              rows={4}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="Add a comment..."
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={closeValidationModal}
              disabled={Boolean(savingAction)}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={Boolean(savingAction)}
              className={
                validationModalAction === "approved"
                  ? "rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
                  : "rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              }
            >
              {savingAction ? "Saving..." : validationModalAction === "approved" ? "Validate Upsell" : "Reject Upsell"}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, CheckCircle2, XCircle } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getAuditUpsell, updateAuditUpsellValidation } from "../../services/firebaseUpsells";
import { getSettings } from "../../services/firebaseSettings";

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
  const { date, auditUpsellId } = useParams();
  const { hotelUid } = useHotelContext();
  const [auditUpsell, setAuditUpsell] = useState(null);
  const [operaUserMappings, setOperaUserMappings] = useState({});
  const [loading, setLoading] = useState(true);
  const [savingAction, setSavingAction] = useState("");
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
        setError("Audit upsell kon niet geladen worden.");
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
        setError("Audit upsell detail kon niet geladen worden.");
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

  const handleValidationAction = async (validationStatus) => {
    const actionLabel = validationStatus === "approved" ? "Validate Upsell" : "Reject Upsell";
    const comment = window.prompt(`${actionLabel}: enter a comment to continue.`);
    if (comment === null) return;

    const cleanedComment = comment.trim();
    if (!cleanedComment) {
      setError("Een comment is verplicht om deze upsell te valideren of te weigeren.");
      return;
    }

    setSavingAction(validationStatus);
    setError("");
    setMessage("");

    try {
      await updateAuditUpsellValidation(
        hotelUid,
        date,
        auditUpsellId,
        validationStatus,
        cleanedComment,
        getCurrentUserPayload(auth.currentUser)
      );
      const refreshedRecord = await getAuditUpsell(hotelUid, date, auditUpsellId);
      setAuditUpsell(refreshedRecord);
      setMessage(validationStatus === "approved" ? "Upsell werd gevalideerd." : "Upsell werd geweigerd.");
    } catch (err) {
      console.error("Failed to update audit upsell validation", err);
      setError("De validatiestatus kon niet opgeslagen worden.");
    } finally {
      setSavingAction("");
    }
  };

  const mappedOperaUser = getMappedOperaUser(auditUpsell?.operaUser, operaUserMappings);
  const nights = getNights(auditUpsell);
  const expectedRevenue = getExpectedRevenue(auditUpsell);
  const detailedFolios = Array.isArray(auditUpsell?.detailedFolios) ? auditUpsell.detailedFolios : [];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <button
          type="button"
          onClick={() => navigate("/front-office/upselling")}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
        >
          <ArrowLeft className="h-4 w-4" /> Terug naar Upselling
        </button>

        {loading ? (
          <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">
            Audit upsell detail wordt geladen...
          </div>
        ) : error && !auditUpsell ? (
          <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>
        ) : !auditUpsell ? (
          <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">
            Audit upsell record werd niet gevonden.
          </div>
        ) : (
          <>
            <header className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-sm uppercase tracking-wide text-gray-500">Upsell Detail</p>
                  <h1 className="mt-2 text-3xl font-semibold text-gray-900">{formatValue(auditUpsell.fullName)}</h1>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Badge className="border-blue-200 bg-blue-50 text-blue-700">{formatValue(auditUpsell.packageCode)}</Badge>
                    <Badge className={statusBadgeClass(auditUpsell.validationStatus)}>
                      Validation: {formatValue(auditUpsell.validationStatus)}
                    </Badge>
                    <Badge className={statusBadgeClass(auditUpsell.folioLinkStatus)}>
                      Folio: {formatValue(auditUpsell.folioLinkStatus)}
                    </Badge>
                  </div>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => handleValidationAction("approved")}
                    disabled={Boolean(savingAction)}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    {savingAction === "approved" ? "Valideren..." : "Validate Upsell"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleValidationAction("rejected")}
                    disabled={Boolean(savingAction)}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 shadow-sm hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <XCircle className="h-4 w-4" />
                    {savingAction === "rejected" ? "Weigeren..." : "Reject Upsell"}
                  </button>
                </div>
              </div>

              <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                {[
                  { label: "Full Name", value: formatValue(auditUpsell.fullName) },
                  { label: "Opera User", value: mappedOperaUser },
                  { label: "Package Code", value: formatValue(auditUpsell.packageCode) },
                  { label: "Package Price", value: formatCurrency(auditUpsell.price) },
                  { label: "Nights", value: nights },
                  { label: "Expected Revenue", value: formatCurrency(expectedRevenue) },
                ].map((item) => (
                  <div key={item.label} className="border-l border-gray-200 pl-3 first:border-l-0 first:pl-0 sm:first:border-l sm:first:pl-3 lg:first:border-l-0 lg:first:pl-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{item.label}</p>
                    <p className="mt-1 text-sm font-semibold text-gray-900">{item.value}</p>
                  </div>
                ))}
              </div>

              <div className="mt-5 grid gap-3 rounded-xl border border-gray-100 bg-gray-50 p-4 text-sm text-gray-700 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <span className="block text-xs font-semibold uppercase tracking-wide text-gray-500">Package Start Date</span>
                  <span className="mt-1 block font-medium text-gray-900">{formatValue(auditUpsell.startDate)}</span>
                </div>
                <div>
                  <span className="block text-xs font-semibold uppercase tracking-wide text-gray-500">Package End Date</span>
                  <span className="mt-1 block font-medium text-gray-900">{formatValue(auditUpsell.endDate)}</span>
                </div>
                <div>
                  <span className="block text-xs font-semibold uppercase tracking-wide text-gray-500">Linked Folios</span>
                  <span className="mt-1 block font-medium text-gray-900">{detailedFolios.length}</span>
                </div>
                <div>
                  <span className="block text-xs font-semibold uppercase tracking-wide text-gray-500">Confirmation</span>
                  <span className="mt-1 block font-medium text-gray-900">{formatValue(auditUpsell.confirmationNumber || auditUpsell.documentId)}</span>
                </div>
              </div>
            </header>

            {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
            {message && <div className="rounded-lg bg-green-50 p-3 text-sm text-green-700">{message}</div>}

            <section className="rounded-xl border border-gray-100 bg-white/70 p-4 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-base font-semibold text-gray-900">Stay details</h2>
                  <p className="mt-1 text-sm text-gray-500">Supporting reservation context.</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg bg-gray-50 px-4 py-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Rate Code</p>
                    <p className="mt-1 text-sm font-medium text-gray-900">{formatValue(auditUpsell.rateCode)}</p>
                  </div>
                  <div className="rounded-lg bg-gray-50 px-4 py-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Room Number</p>
                    <p className="mt-1 text-sm font-medium text-gray-900">{formatValue(auditUpsell.roomNumber)}</p>
                  </div>
                </div>
              </div>
            </section>

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
                      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:max-w-xl">
                        <div className="rounded-lg bg-gray-50 p-3">
                          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Bill number</p>
                          <p className="mt-1 text-sm font-medium text-gray-900">{formatValue(folio?.billNumber)}</p>
                        </div>
                        <div className="rounded-lg bg-gray-50 p-3">
                          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Room number</p>
                          <p className="mt-1 text-sm font-medium text-gray-900">{formatValue(folio?.roomNumber)}</p>
                        </div>
                      </div>
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
                                  Geen transacties gevonden voor deze folio.
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

            <details className="rounded-xl border border-gray-200 bg-white/70 p-5 shadow-sm">
              <summary className="cursor-pointer text-base font-semibold text-gray-800">Audit details</summary>
              <div className="mt-4">
                <DetailGrid
                  subtle
                  items={[
                    { label: "Log date", value: formatValue(auditUpsell.logDate || auditUpsell.dateKey) },
                    { label: "Log time", value: formatValue(auditUpsell.logTime) },
                    { label: "Raw opera user", value: formatValue(auditUpsell.operaUser) },
                    { label: "Mapped opera user", value: mappedOperaUser },
                    { label: "Package code", value: formatValue(auditUpsell.packageCode) },
                    { label: "Price", value: formatCurrency(auditUpsell.price) },
                    { label: "Validation comment", value: formatValue(auditUpsell.validationComment) },
                  ]}
                />
              </div>
            </details>
          </>
        )}
      </PageContainer>
    </div>
  );
}

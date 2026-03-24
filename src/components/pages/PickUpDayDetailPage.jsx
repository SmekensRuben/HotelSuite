import React from "react";
import { ArrowLeft } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { signOut, auth } from "../../firebaseConfig";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";

function formatCurrency(value) {
  return Number(value || 0).toLocaleString(undefined, {
    style: "currency",
    currency: "EUR",
  });
}

function formatSignedNumber(value) {
  const numericValue = Number(value || 0);
  const prefix = numericValue > 0 ? "+" : "";
  return `${prefix}${numericValue.toLocaleString()}`;
}

function formatSignedCurrency(value) {
  const numericValue = Number(value || 0);
  const prefix = numericValue > 0 ? "+" : "";
  return `${prefix}${formatCurrency(numericValue)}`;
}

function getDeltaTextClass(value) {
  if (value > 0) return "text-green-600";
  if (value < 0) return "text-red-600";
  return "text-gray-600";
}

export default function PickUpDayDetailPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { stayDate } = useParams();

  const row = location.state?.row || null;
  const pickupComparisonDays = Math.max(1, Number(location.state?.pickupComparisonDays) || 1);

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  const marketCodeRows = row?.marketCodeComparisonEntries || [];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer>
        <Card className="space-y-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <button
                type="button"
                onClick={() => navigate(-1)}
                className="mb-3 inline-flex items-center gap-2 text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                <ArrowLeft size={16} />
                Terug naar Pick-Up overzicht
              </button>
              <h1 className="text-2xl font-semibold text-gray-900">Pick-Up detail: {stayDate}</h1>
              <p className="mt-2 text-sm text-gray-600">
                Details per market code voor deze dag, inclusief totalen en pick-up versus dag -
                {pickupComparisonDays}.
              </p>
            </div>
          </div>

          {!row ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
              Geen detaildata gevonden voor deze dag. Open deze pagina via een klik op een rij in het
              Pick-Up overzicht.
              <div className="mt-2">
                <Link to="/revenue-management/pick-up" className="font-semibold underline">
                  Ga naar Pick-Up overzicht
                </Link>
              </div>
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    Rooms Sold
                  </div>
                  <div className="mt-1 text-lg font-semibold text-gray-900">
                    {Number(row.roomsSold || 0).toLocaleString()}
                  </div>
                  <div className={`mt-1 text-sm font-medium ${getDeltaTextClass(row.roomsSoldDelta)}`}>
                    Pick-up: {formatSignedNumber(row.roomsSoldDelta)}
                  </div>
                </div>
                <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    Calculated Revenue
                  </div>
                  <div className="mt-1 text-lg font-semibold text-gray-900">
                    {formatCurrency(row.totalCalculatedRevenue)}
                  </div>
                  <div
                    className={`mt-1 text-sm font-medium ${getDeltaTextClass(
                      row.totalCalculatedRevenue - row.previousTotalCalculatedRevenue
                    )}`}
                  >
                    Pick-up: {formatSignedCurrency(row.totalCalculatedRevenue - row.previousTotalCalculatedRevenue)}
                  </div>
                </div>
                <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Avg ADR</div>
                  <div className="mt-1 text-lg font-semibold text-gray-900">{formatCurrency(row.avgAdr)}</div>
                  <div className={`mt-1 text-sm font-medium ${getDeltaTextClass(row.avgAdrDelta)}`}>
                    Pick-up: {formatSignedCurrency(row.avgAdrDelta)}
                  </div>
                </div>
                <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    Market Codes
                  </div>
                  <div className="mt-1 text-lg font-semibold text-gray-900">
                    {marketCodeRows.length.toLocaleString()}
                  </div>
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                          Market Code
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                          Rooms Sold
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                          Pick-up Rooms
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                          Calculated Revenue
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                          Pick-up Revenue
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                          Avg ADR
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                          Pick-up ADR
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white">
                      {marketCodeRows.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-4 py-6 text-sm text-gray-500">
                            Geen market code details beschikbaar voor deze dag.
                          </td>
                        </tr>
                      ) : (
                        marketCodeRows.map((item) => (
                          <tr key={item.marketCode}>
                            <td className="px-4 py-3 text-sm text-gray-700">{item.marketCode}</td>
                            <td className="px-4 py-3 text-sm text-gray-700">
                              {Number(item.roomsSold || 0).toLocaleString()}
                            </td>
                            <td
                              className={`px-4 py-3 text-sm font-medium ${getDeltaTextClass(
                                item.roomsSoldDelta
                              )}`}
                            >
                              {formatSignedNumber(item.roomsSoldDelta)}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-700">
                              {formatCurrency(item.totalCalculatedRevenue)}
                            </td>
                            <td
                              className={`px-4 py-3 text-sm font-medium ${getDeltaTextClass(
                                item.totalCalculatedRevenueDelta
                              )}`}
                            >
                              {formatSignedCurrency(item.totalCalculatedRevenueDelta)}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-700">{formatCurrency(item.avgAdr)}</td>
                            <td
                              className={`px-4 py-3 text-sm font-medium ${getDeltaTextClass(
                                item.avgAdrDelta
                              )}`}
                            >
                              {formatSignedCurrency(item.avgAdrDelta)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </Card>
      </PageContainer>
    </div>
  );
}

import React from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Circle, ShieldAlert } from "lucide-react";
import { getHotelSetupReadiness } from "../../services/firebaseOnboarding";
import { usePlatformQuery } from "../../hooks/usePlatformQuery";
import { Moment, QueryState, Status, button, panel } from "./PlatformShared";

const nextActions = {
  activation: "Complete the reviewed platform release once for the project.",
  team: "Assign hotel administrators and operational roles; review invitations and account consistency.",
  procurement: "Ask a licensed module manager to configure outlets, suppliers, supplier products and stock locations in the hotel workspace.",
};
export default function HotelSetupChecklist({ hotelUid, refreshKey = 0 }) {
  const query = usePlatformQuery(() => getHotelSetupReadiness(hotelUid), `${hotelUid}:${refreshKey}`);
  const linkFor = (action) => action === "subscription" ? "/platform/subscriptions"
    : action === "team" ? `/platform/hotels/${hotelUid}/team`
      : action === "imports" ? `/platform/hotels/${hotelUid}/imports`
        : action === "hotel" ? `/platform/hotels/${hotelUid}` : null;
  return <section className={`${panel} space-y-4`} aria-label="Hotel setup checklist">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Hotel setup checklist</h2>
      <p className="mt-1 text-sm text-slate-600">A current setup assessment. Access and import health are checked separately.</p></div>
      <button type="button" className={button} disabled={query.loading} onClick={query.refresh}>Check setup again</button></div>
    <QueryState query={query}>{query.data && <>
      <div className="flex flex-wrap items-center gap-3"><Status value={query.data.status} /><span className="text-xs text-slate-500">Checked <Moment value={query.data.computedAtMillis} /></span></div>
      <ol className="divide-y divide-slate-100">{query.data.checks.map((check) => {
        const complete = ["ready", "not-applicable"].includes(check.status);
        const Icon = complete ? CheckCircle2 : check.status === "blocked" ? ShieldAlert : Circle;
        const to = linkFor(check.action);
        return <li key={check.id} className="flex items-start gap-3 py-4"><Icon size={20} className={complete ? "mt-1 shrink-0 text-emerald-700" : "mt-1 shrink-0 text-amber-700"} aria-hidden="true" />
          <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-3"><h3 className="text-sm font-semibold">{check.label}</h3><Status value={check.status} /></div>
            <p className="mt-2 text-sm leading-6 text-slate-600">{check.detail}</p>
            {!complete && nextActions[check.action] && <p className="mt-2 text-sm text-slate-600">{nextActions[check.action]}</p>}
            {!complete && to && <Link className="mt-2 inline-block text-sm font-semibold text-brand-800 underline" to={to}>Manage {check.action === "hotel" ? "hotel details" : check.action}</Link>}</div></li>;
      })}</ol>
      {query.data.integrity.issueCount > 0 && <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4"><h3 className="font-semibold">Account records need review</h3>
        <p className="mt-2 text-sm">No accounts, assignments or credentials were changed by this check.</p>
        <ul className="mt-3 space-y-2 text-xs">{query.data.integrity.issues.map((issue) => <li key={issue.uid}><code className="break-all">{issue.uid}</code>: {issue.codes.map((code) => code.replace(/-/g, " ")).join(", ")}</li>)}</ul>
        {query.data.integrity.issuesTruncated && <p className="mt-2 text-sm">Showing the first 100 affected accounts.</p>}</div>}
      {query.data.recentInvitations.length > 0 && <div><h3 className="text-sm font-semibold">Latest 10 invitations</h3><p className="mt-1 text-xs text-slate-500">Delivery status is separate from account verification. Invitation links and email contents are private.</p>
        <ul className="mt-3 space-y-2 text-sm">{query.data.recentInvitations.map((invite) => <li key={invite.id} className="flex flex-wrap items-center gap-3"><code className="break-all text-xs">{invite.uid}</code><Status value={invite.status} /><Moment value={invite.createdAtMillis} /></li>)}</ul></div>}
    </>}</QueryState>
  </section>;
}

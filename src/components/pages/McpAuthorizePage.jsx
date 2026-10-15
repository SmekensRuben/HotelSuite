import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuthContext } from "../../contexts/AuthContext";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { completeMcpConsent, getMcpConsent } from "../../services/firebaseMcpConnections";
import PageContainer from "../layout/PageContainer";
import AsyncError from "../shared/AsyncError";

const navigateToClient = (url) => window.location.assign(url);

export default function McpAuthorizePage({ onRedirect = navigateToClient }) {
  const { currentUser, authLoading } = useAuthContext();
  const [parameters] = useSearchParams();
  const requestId = parameters.get("requestId") || "";
  return <PageContainer className="max-w-2xl space-y-6 py-8">
    <div><p className="text-sm font-medium text-brand-800">Hotel Toolkit MCP</p><h1 className="mt-2 text-3xl font-semibold">Connect your AI client</h1></div>
    {authLoading ? <p role="status">Checking your account…</p> : !currentUser?.emailVerified
      ? <p role="alert">Sign in with a verified Hotel Toolkit account to authorize this connection.</p>
      : <McpConsent key={`${currentUser.uid}:${requestId}`} actor={currentUser} requestId={requestId} onRedirect={onRedirect} />}
    <Link to="/settings/connections" className="inline-block text-sm font-semibold text-brand-800 underline">Manage my MCP connections</Link>
  </PageContainer>;
}

function McpConsent({ actor, requestId, onRedirect }) {
  const scopeKey = useMemo(() => ({ actor, requestId }), [actor, requestId]);
  const load = useCallback(() => getMcpConsent(requestId), [requestId]);
  const query = useScopedAsync({ scopeKey, enabled: Boolean(requestId), load });
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [completion, setCompletion] = useState(null);
  const latestActor = useRef(actor), active = useRef(true);
  latestActor.current = actor;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const decide = async (approve) => {
    if (busy || !query.data || completion) return;
    setBusy(true); setError(null);
    const current = () => active.current && latestActor.current === actor;
    try {
      const result = await completeMcpConsent(requestId, approve, query.data.client.redirectOrigin);
      if (!current()) return;
      setCompletion({ approve, redirectUrl: result.redirectUrl });
      onRedirect(result.redirectUrl);
    } catch (failure) { if (current()) setError(failure); }
    finally { if (current()) setBusy(false); }
  };
  if (!requestId) return <p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">Start the connection in ChatGPT or Codex, then open its Hotel Toolkit authorization link.</p>;
  return <section aria-label="MCP connection authorization" className="space-y-5 rounded-2xl border bg-white p-5 sm:p-6">
    <AsyncError error={query.error} onRetry={query.retry} label="Could not load this authorization request." />
    {query.loading && <p role="status">Loading the client’s request…</p>}
    {query.data && <>
      <div><h2 className="break-words text-xl font-semibold">{query.data.client.name} wants to connect</h2><p className="mt-2 text-sm text-gray-600">Signed in as <span className="break-all font-medium">{actor.email || "your Hotel Toolkit account"}</span>.</p><p className="mt-1 break-all text-xs text-gray-500">Client return address: {query.data.client.redirectOrigin}</p></div>
      <div><h3 className="font-semibold">Requested access</h3><ul className="mt-3 space-y-3">{query.data.scopes.map((scope) => <li key={scope.id} className="rounded-xl bg-gray-50 p-3"><p className="text-sm font-semibold">{scope.label}</p><p className="mt-1 text-sm text-gray-600">{scope.description}</p></li>)}</ul></div>
      <div className="space-y-2 rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-950"><p>This connection uses your current hotel access, permissions and subscription. It does not grant access to additional hotels. A platform administrator account does not automatically gain operational hotel access.</p><p>Product changes are saved as proposals. A person must review and approve them in Hotel Toolkit before they affect active products. The AI client cannot approve its own proposals.</p><p>You can revoke this personal connection at any time in MCP connections.</p></div>
      <p className="text-xs text-gray-500">This request expires {new Date(query.data.expiresAt).toLocaleString()}.</p>
      {completion ? <div role="status" className="space-y-3 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-900"><p>{completion.approve ? "Connection authorized." : "Connection declined."} Returning to your client…</p><a href={completion.redirectUrl} className="font-semibold underline">Continue to {query.data.client.name}</a></div>
        : <div className="flex flex-wrap gap-3"><button type="button" className="ht-button-primary" disabled={busy} onClick={() => decide(true)}>{busy ? "Completing request…" : "Allow connection"}</button><button type="button" className="ht-button-secondary" disabled={busy} onClick={() => decide(false)}>Deny connection</button></div>}
      <AsyncError error={error} label="Could not complete this authorization request." />
    </>}
  </section>;
}

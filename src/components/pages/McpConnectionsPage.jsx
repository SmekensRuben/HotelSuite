import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuthContext } from "../../contexts/AuthContext";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { listMcpConnections, revokeMcpConnection } from "../../services/firebaseMcpConnections";
import { workspaceHome } from "../../utils/workspace";
import PageContainer from "../layout/PageContainer";
import AsyncError from "../shared/AsyncError";

export default function McpConnectionsPage() {
  const { currentUser, authLoading, isPlatformAdmin, hotelUids } = useAuthContext();
  return <PageContainer className="max-w-4xl space-y-6 py-8">
    <Link to={workspaceHome({ isPlatformAdmin, hotelUids })} className="inline-block text-sm font-semibold text-brand-800 underline">Back to workspace</Link>
    <div><p className="text-sm font-medium text-brand-800">My account</p><h1 className="mt-2 text-3xl font-semibold">MCP connections</h1><p className="mt-2 text-sm text-gray-600">Connect ChatGPT or Codex to your Hotel Toolkit account. Each client uses your current hotel permissions; product changes remain proposals until approved in Hotel Toolkit.</p></div>
    {authLoading ? <p role="status">Checking your account…</p> : !currentUser?.emailVerified
      ? <p role="alert">Sign in with a verified Hotel Toolkit account to manage your connections.</p>
      : <PersonalMcpConnections key={currentUser.uid} actor={currentUser} />}
  </PageContainer>;
}

function PersonalMcpConnections({ actor }) {
  const load = useCallback(() => listMcpConnections(), []);
  const query = useScopedAsync({ scopeKey: actor, load });
  const [confirm, setConfirm] = useState(null), [busy, setBusy] = useState(null), [error, setError] = useState(null), [notice, setNotice] = useState("");
  const latestActor = useRef(actor), active = useRef(true);
  latestActor.current = actor;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const revoke = async (connection) => {
    if (busy) return;
    setBusy(connection.id); setError(null); setNotice("");
    const current = () => active.current && latestActor.current === actor;
    try {
      await revokeMcpConnection(connection.id);
      if (!current()) return;
      setConfirm(null); setNotice(`${connection.clientName} connection revoked.`); await query.retry();
    } catch (failure) { if (current()) setError(failure); }
    finally { if (current()) setBusy(null); }
  };
  const copyAddress = async () => {
    setError(null); setNotice("");
    try {
      await navigator.clipboard.writeText(query.data.configuration.resourceUrl);
      if (active.current && latestActor.current === actor) setNotice("MCP server URL copied.");
    } catch { if (active.current && latestActor.current === actor) setError(new Error("The address could not be copied. Select and copy the MCP server URL below.")); }
  };
  return <div className="space-y-6">
    <AsyncError error={query.error} onRetry={query.retry} label="Could not load your MCP connections." />
    {query.loading && <p role="status">Loading your connections…</p>}
    {query.data && <>
      <section aria-labelledby="mcp-connect-heading" className="space-y-4 rounded-2xl border bg-white p-5 sm:p-6"><h2 id="mcp-connect-heading" className="text-xl font-semibold">Connect a client</h2>
        {query.data.configuration.enabled && query.data.configuration.resourceUrl ? <>
          <p className="text-sm text-gray-600">Ask your operator for a preregistered OAuth client ID and any required client credentials, then add this URL as a remote MCP server in that client. The server URL alone does not authorize an unregistered client. When asked, sign in to Hotel Toolkit and review the requested access. Keep this connection private while testing.</p>
          <label className="block text-sm font-medium">MCP server URL<input readOnly value={query.data.configuration.resourceUrl} className="ht-field mt-1 w-full font-mono text-sm" onFocus={(event) => event.target.select()} /></label>
          <button type="button" className="ht-button-secondary" onClick={copyAddress}>Copy MCP server URL</button>
        </> : <p className="text-sm text-amber-900">MCP connections are not enabled for this environment. An operator must finish the private MCP hosting and OAuth configuration before a client can connect.</p>}
        <p className="text-sm text-gray-600">You do not need to select a hotel here. Your client can discover only your accessible hotels and must select a specific hotel for every product action.</p>
      </section>
      <section aria-labelledby="mcp-personal-heading" className="space-y-4"><h2 id="mcp-personal-heading" className="text-xl font-semibold">Your authorized clients</h2><p className="text-sm text-gray-600">These connections belong to your account. Revocation stops this client from using the connection; existing product proposals stay available for review.</p>
        {query.data.connections.length === 0 ? <p className="rounded-xl border border-dashed p-5 text-sm text-gray-500">No authorized MCP clients yet.</p> : <ul className="space-y-4">{query.data.connections.map((connection) => <li key={connection.id} className="space-y-3 rounded-2xl border bg-white p-5"><div><h3 className="break-words font-semibold">{connection.clientName}</h3><p className="mt-1 text-xs text-gray-500">Connected {new Date(connection.createdAt).toLocaleString()} · Expires {new Date(connection.expiresAt).toLocaleString()}</p><p className="mt-2 break-words text-sm text-gray-600">Access: {connection.scopes.join(", ")}</p></div>
          {confirm === connection.id ? <div className="space-y-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-950"><p>Revoke access for {connection.clientName}? The client must reconnect and ask for your consent to use Hotel Toolkit again.</p><div className="flex flex-wrap gap-3"><button type="button" className="ht-button-secondary text-red-700" disabled={Boolean(busy)} onClick={() => revoke(connection)}>{busy === connection.id ? "Revoking…" : "Confirm revocation"}</button><button type="button" className="ht-button-secondary" disabled={Boolean(busy)} onClick={() => { setConfirm(null); setError(null); }}>Keep connection</button></div></div>
            : <button type="button" className="ht-button-secondary text-red-700" disabled={Boolean(busy)} onClick={() => { setConfirm(connection.id); setError(null); setNotice(""); }} aria-label={`Revoke ${connection.clientName} connection`}>Revoke connection</button>}
        </li>)}</ul>}
      </section>
    </>}
    <AsyncError error={error} label="Could not update your MCP connection." />
    {notice && <p role="status" className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-900">{notice}</p>}
  </div>;
}

import React, { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { listPlatformAudit } from "../../services/firebasePlatform";
import { usePlatformQuery } from "../../hooks/usePlatformQuery";
import { Title, QueryState, Moment, button, panel } from "./PlatformShared";

export default function PlatformActivityPage() {
  const [params] = useSearchParams(), hotelUid = params.get("hotelUid");
  const [cursor, setCursor] = useState(null), [previous, setPrevious] = useState([]);
  const query = usePlatformQuery(() => listPlatformAudit(cursor, hotelUid), `${hotelUid || "all"}:${cursor || "first"}`);
  return <><Title title="Activity & audit" actions={<button className={button} onClick={query.refresh}>Refresh</button>}>Server-recorded platform changes and support access. Historical hotel audit records remain available through their original workflows.</Title>
    <QueryState query={query}><section className={panel}>{hotelUid && <p className="mb-4 text-sm">Hotel: {hotelUid} · <Link className="underline" to="/platform/activity">Show all platform activity</Link></p>}<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-3">When</th><th className="p-3">Action</th><th className="p-3">Hotel</th><th className="p-3">Actor</th><th className="p-3">Revision</th></tr></thead><tbody>{query.data?.events.map((event) => <tr className="border-b" key={event.id}><td className="p-3"><Moment value={event.createdAtMillis} /></td><td className="p-3">{event.action.replace(/-/g, " ")}</td><td className="p-3">{event.hotelUid ? <Link className="underline" to={`/platform/hotels/${event.hotelUid}`}>{event.hotelUid}</Link> : "Platform account"}</td><td className="max-w-48 break-all p-3 text-xs">{event.actorUid}</td><td className="p-3">{event.revision ?? "—"}</td></tr>)}</tbody></table></div>{!query.data?.events.length && <p className="mt-4">No platform activity is available in this view yet.</p>}<div className="mt-5 flex justify-between"><button className={button} disabled={!previous.length} onClick={() => { setCursor(previous.at(-1)); setPrevious(previous.slice(0, -1)); }}>Previous page</button><button className={button} disabled={!query.data?.nextCursor} onClick={() => { setPrevious([...previous, cursor]); setCursor(query.data.nextCursor); }}>Next page</button></div></section></QueryState></>;
}

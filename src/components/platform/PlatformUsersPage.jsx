import React, { useState } from "react";
import { Link } from "react-router-dom";
import { listPlatformUsers } from "../../services/firebasePlatform";
import { usePlatformQuery } from "../../hooks/usePlatformQuery";
import { Title, QueryState, button, panel, field } from "./PlatformShared";

export default function PlatformUsersPage() {
  const [cursor, setCursor] = useState(null), [previous, setPrevious] = useState([]), [search, setSearch] = useState("");
  const query = usePlatformQuery(() => listPlatformUsers(cursor), cursor);
  const users = (query.data?.users || []).filter((user) => `${user.firstName} ${user.lastName} ${user.email || ""}`.toLowerCase().includes(search.toLowerCase()));
  return <><Title title="Users" actions={<button className={button} onClick={query.refresh}>Refresh</button>}>Named accounts and explicit hotel assignments. Platform administrators can have zero hotel assignments.</Title><QueryState query={query}><section className={panel}><label className="block max-w-md text-sm">Find on this page<input className={field} value={search} onChange={(event) => setSearch(event.target.value)} /></label><div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-3">User</th><th className="p-3">Sign-in email</th><th className="p-3">Hotel assignments</th><th className="p-3">Account</th></tr></thead><tbody>{users.map((user) => <tr key={user.id} className="border-b"><td className="p-3"><Link className="font-medium underline" to={`/platform/users/${user.id}`}>{[user.firstName, user.lastName].filter(Boolean).join(" ") || user.id}</Link></td><td className="p-3">{user.email || "Unavailable"}</td><td className="p-3">{user.hotelUid.length ? user.hotelUid.join(", ") : "None"}</td><td className="p-3">{user.disabled == null ? "Unavailable" : user.disabled ? "Disabled" : "Enabled"}</td></tr>)}</tbody></table></div>{!users.length && <p className="mt-4">No users match this page.</p>}<div className="mt-5 flex justify-between"><button className={button} disabled={!previous.length} onClick={() => { setCursor(previous.at(-1)); setPrevious(previous.slice(0, -1)); }}>Previous page</button><button className={button} disabled={!query.data?.nextCursor} onClick={() => { setPrevious([...previous, cursor]); setCursor(query.data.nextCursor); }}>Next page</button></div></section></QueryState></>;
}

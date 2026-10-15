# Hotel Toolkit MCP: private product pilot

This implementation connects a remote MCP client to an existing, verified Hotel
Toolkit account. It reads permitted product data and saves proposals in Firebase.
Only the requester can review their private batches in Hotel Toolkit. Product
creation and changes require a separate, explicit approval there.

The connection is disabled by default. This change does not deploy a server,
enable a production connection, migrate product data, or publish an OpenAI app.

## Architecture and identity

`hotelMcp` is a Firebase Functions v2 HTTPS endpoint behind Firebase Hosting.
The canonical issuer is an HTTPS **origin**, for example
`https://YOUR_TEST_PROJECT.web.app`; the resource is exactly that origin's `/mcp`.
Do not configure a path-prefixed `cloudfunctions.net/hotelMcp` URL as the issuer.
The tracked Hosting rewrites send `/mcp`, `/authorize`, `/token`, `/revoke` and
OAuth discovery paths to the function. `/mcp/authorize` remains a frontend route.
`APP_BASE_URL` identifies the Hotel Toolkit frontend used for sign-in and consent;
it may have a different origin from the MCP issuer.

The server uses the official `@modelcontextprotocol/sdk` 1.32 maintenance line
for OAuth handlers and stateless Streamable HTTP. Official upstream documentation
states that v1 receives security and bug fixes for at least six months after the
July 27, 2026 v2 release, through at least January 2027. This is a deliberate
supported-maintenance choice for a first private connection that reuses Firebase
identity and can be tested end to end. Upstream v2 recommends a dedicated external
authorization server and freezes its old authorization-server helpers. Plan the
authorization-server replacement and v2 transport upgrade before v1 support ends;
this implementation does not depend on the frozen v2 legacy package.

OAuth uses pre-registered public clients, S256 PKCE, exact registered callbacks
(with the standard loopback-port exception), resource-bound opaque access tokens,
single-use authorization codes and rotating refresh tokens. Only SHA-256 token
and authorization-request digests are stored. Codes expire after one minute,
access tokens after ten minutes and connections after thirty days. Reusing a
refresh token revokes its connection. Issuer identification in authorization
responses supports current Codex callback verification.

The consent page uses the normal Firebase session. The AI never supplies a user
ID or uses a shared administrator key. Every data action rechecks the personal
connection, current Firebase account, current hotel membership, required action
and procurement subscription. Disabled/deleted/unverified accounts, Firebase
token revocation, removed memberships and withdrawn module access take effect
for existing connections. Platform administrator claims do not grant operational
hotel access. Consent cannot add hotel permissions.

The two consent scopes are `hotel-toolkit:read` and `hotel-toolkit:propose`.
Proposing also requires read consent. Missing scopes produce an incremental OAuth
challenge; missing hotel permissions produce an authorization error, since another
consent cannot grant those permissions. Native review callables require the same
current product permissions and reject MCP authentication contexts.

## Tools and product contracts

All tools have strict input and output schemas, bounded responses and focused
descriptions. There is no arbitrary path, query, document mutation, approval or
platform-management tool.

| Tools | Purpose |
| --- | --- |
| `discover_hotels` | Return only current assigned product-access hotels and their available actions. |
| `list_catalog_products`, `search_catalog_products`, `get_catalog_product` | Read canonical catalog data and revisions. |
| `list_supplier_products`, `search_supplier_products`, `get_supplier_product` | Read canonical supplier articles and purchase terms. |
| `list_product_references` | Read suppliers, taxonomy, or an exact supplier/source-format mapping profile. |
| `get_product_workflow_metadata` | Read supported fields, physical units and validation rules for one product kind. |
| `stage_product_proposals` | Save up to 25 create/update proposals, with a stable request ID. |
| `get_product_proposal_batch`, `list_product_proposal_batches` | Read the requester's own validation, progress and results. |

Every hotel action requires an explicit `hotelUid`. Discovery reads the current
user's assigned IDs and checks their membership and license; it never scans all
hotels for a platform administrator. Ambiguous hotel names require a user choice.
Product/reference pages contain at most 50 records. Product cursors bind the user,
hotel and filters; proposal pages contain at most 25 batches, newest first, and
validate the owner of their cursor anchor.

Search reuses the existing Meilisearch configuration. Indexed hits are hydrated
from the authorized hotel's canonical Firestore documents before projection.
Indexing may lag; bounded Firestore listing and detail reads remain available if
search is unavailable. Suppliers expose only IDs, names, availability and price
date basis. Credentials, supplier account/contact details, private media handles
and arbitrary document fields are excluded.

Catalog products currently store **category and subcategory names**, while taxonomy
subcategory records refer to their parent's document ID. The form and proposal
editor use existing-value comboboxes. MCP proposals store the matching names and
check the actual same-hotel taxonomy relationship at staging and approval. There
is no category-ID migration or category-creation tool. Missing classification
remains visible as a warning; nonexistent or mismatched choices block approval.

Use supplier and catalog IDs returned for the same hotel. A supplier mapping is
read through its exact supplier, format and profile, with the existing mapping
validator. A referenced mapping's fingerprint/revision is retained. Wrong-source
mappings are rejected; changed mappings require human correction before applying
affected rows. Source text and URLs are data, never instructions. The server does
not crawl sites or run an AI extraction agent.

## Shared portion-count guidance

Unit-selection guidance belongs to the MCP server and its authenticated
`get_product_workflow_metadata` response, so every authorized client can retrieve
the same rules without relying on one user's chat history or personal memory.
Server instructions and both metadata/staging tool descriptions tell clients to
fetch the rules for each product kind before preparing proposals.

For a new product explicitly sold as individually consumed single servings,
prefer counting one portion as `each`. Preserve an existing reviewed catalog or
supplier unit, or an explicit user choice, instead of silently changing an
established identity. A jar or bottle is not automatically a single serving.
Bulk products retain an appropriate mass or volume unit; missing counts and
ambiguous usage need human review rather than an inferred conversion.

For source-confirmed chocolate spread **64 single-serving jars x 25 g per box**:

| Field | Proposed value |
| --- | --- |
| Supplier product name | Chocolate spread 25 g portions, box of 64 jars |
| `baseUnit` | `each` (one portion) |
| `purchaseUnit` | `Box` |
| `baseUnitsPerPurchaseUnit` | `64` |
| `pricePerPurchaseUnit` | The quoted box price, with its actual currency and price basis |
| `gtin` | The box barcode, if established by the source |

Do not automatically collapse these 64 portions into 1,600 g. Conversely, if
the matching reviewed catalog identity uses grams, preserve that identity and
its compatible offer conversion unless the user explicitly requests a separate
count-based identity. Different portion sizes are not automatically
interchangeable simply because both use `each`.

The current MCP schema has no separate structured weight-per-item field. Preserve
25 g in supported names or catalog descriptions/notes; that descriptive value
does not authorize a grams-to-items conversion. Do not invent a purchasable
single-jar option, a price, or an inner/outer barcode relationship.

These are shared preparation instructions, not a new validation requirement or
a guarantee that every AI client follows them. Existing server-side dimensional
validation and human approval remain authoritative. This update changes no
product schema or historical data and does not automatically rewrite proposals
already prepared. After review and deployment, newly fetched metadata supplies
the guidance to clients using that server. Clients caching tool descriptions
may need a refresh to see the updated descriptions.

## Preparing and reviewing a batch

Ask the client to discover hotels, select the destination, find the supplier and
read matching products and workflow metadata before staging. Existing updates
need their real product ID and current `expectedRevision`. New identities are
assigned by the backend. A supplier proposal can use an existing `catalogProductId`
or refer to a catalog proposal's `rowId` through `catalogRowId`.

For example, after replacing all placeholder IDs with tool results:

```json
{
  "hotelUid": "HOTEL_ID_FROM_DISCOVERY",
  "requestId": "retain-this-unique-request-id-for-retries",
  "source": { "label": "Sligro product information", "sourceFormat": "web" },
  "rows": [
    {
      "rowId": "catalog-orange-juice",
      "kind": "catalog",
      "action": "create",
      "product": { "name": "Orange juice", "baseUnit": "l", "inventoryTracked": true }
    },
    {
      "rowId": "supplier-orange-juice",
      "kind": "supplier",
      "action": "create",
      "catalogRowId": "catalog-orange-juice",
      "product": {
        "supplierId": "SUPPLIER_ID_FROM_REFERENCES",
        "supplierSku": "ARTICLE_NUMBER_FROM_SOURCE",
        "supplierProductName": "Orange juice 6 x 1 l",
        "baseUnit": "l",
        "purchaseUnit": "case",
        "baseUnitsPerPurchaseUnit": 6,
        "currency": "EUR",
        "priceBasis": "unknown"
      }
    }
  ]
}
```

Only include those packaging, currency and identity facts when the actual source
establishes them. This example deliberately omits prices, VAT, dates, categories
and allergens. Missing required information remains an invalid proposal for human
correction; optional unknowns remain visible. Never invent missing values to make
a proposal pass validation.

Open **Catalog Products → Product proposals** and select the batch. Supplier-only
readers find the same action on Supplier Products. The review shows source,
original/proposed values, new/changed/unchanged rows, exceptions and applied IDs.
Correct fields, skip rows, or select valid proposals and confirm approval. Selecting
a supplier row also includes an eligible catalog dependency. Actual catalog IDs
are resolved before supplier commands execute.

Omitted patch fields preserve existing information. Explicit blank/null clears
only fields that support clearing; explicit zero prices remain zero. Nonempty
`purchaseOptions` patches upsert stable option IDs and preserve omitted options
and nested fields. An explicit `[]` deliberately clears all additional options.
Deleting one existing option is outside this pilot's proposal contract; use the
normal Supplier Product editor for that change. The proposal editor labels and
enforces this distinction. Internal SKU allocation, unique reservations, audit
fields and price evidence use the existing protected backend. Images can be
uploaded through the existing supported workflow after approval.

Only explicitly supplied unit prices create price confirmations. Descriptive
changes do not refresh price evidence. Existing approved versions, future prices,
effective-date agreements and older-source protections remain in effect. Historical
orders, receipts, counts, movements and valuations are never rewritten.

Keep the same `requestId` and identical payload when retrying an uncertain stage
or review. Each product change and its durable row receipt share one transaction.
Interruptions between rows leave a private pending command that the review page
recovers after a reload or on another browser. Previously applied rows are reused.
Conflicts require comparing current values and explicitly acknowledging the new
revision; refreshing alone does not overwrite another edit. A different proposal
payload needs a new request ID. This is retry protection, not automatic semantic
deduplication of unrelated new-catalog requests.

## Private installation

The Functions are published in Firebase project **hotel-toolkit**. The frontend,
sign-in, consent and review pages stay on Firebase App Hosting at
`https://hotel-toolkit--hotel-toolkit.europe-west4.hosted.app`. The MCP gateway uses
Firebase Hosting site **hotel-toolkit**, with issuer `https://hotel-toolkit.web.app`
and resource `https://hotel-toolkit.web.app/mcp`.

The following commands are operator actions after this change is reviewed and
merged. This change does not set live variables or publish anything. Existing
SaaS memberships, procurement access, Rules and indexes remain prerequisites.
Follow [Functions release controls](functions-continuous-deployment.md).

### Repository variables

Configure **SmekensRuben/HotelSuite → Settings → Secrets and variables → Actions →
Variables → Repository variables**, or use the commands below.

| Repository variable | Default | Enabled pilot value |
| --- | --- | --- |
| `HOTEL_MCP_ENABLED` | Unset, empty, or `false` keeps MCP disabled | Exactly `true` |
| `HOTEL_MCP_PUBLIC_ORIGIN` | Empty when disabled | `https://hotel-toolkit.web.app` |
| `HOTEL_MCP_CLIENTS_JSON` | `[]` when disabled | Array of 1–20 pre-registered public PKCE clients |
| `HOTEL_MCP_ALLOWED_ORIGINS_JSON` | `[]` | Array of up to twenty extra HTTPS browser origins; empty/unset means `[]` |

These are public server configuration, not secrets or frontend `VITE_*` values.
The workflow passes them to `check-functions-runtime.sh`. Activation validates
JSON, a public HTTPS issuer origin, unique client IDs and exact callbacks. Each
client allows `client_id`, optional `client_name`, `redirect_uris` (1–10 canonical
URLs) and optional `token_endpoint_auth_method` (defaults to `none`). Secret fields,
other authentication methods and wildcard callbacks are rejected. JSON parameters
are limited to 32 KiB each. Public origins require a domain name without a port,
path, credentials, query or fragment. Validation checks structure, not DNS or
endpoint reachability.

`APP_BASE_URL` stays on the existing App Hosting origin, versioned as
`FUNCTIONS_APP_BASE_URL` in the workflow. CI regenerates ignored
`functions/.env.hotel-toolkit` with all five parameters. The locked Firebase CLI
needs explicit values despite SDK defaults; editing a local dotenv file does not
configure the next release. With activation unset/empty or `false`, stale or
incomplete activation settings are ignored and replaced with disabled defaults.
Any other activation flag fails validation.

### Publish only the gateway

Use Node 22, npm 10.9.9 and an authenticated operator with permission to publish
the existing Hosting site. Start with a reviewed current-main checkout:

```bash
git clone https://github.com/SmekensRuben/HotelSuite.git hotelsuite-mcp
cd hotelsuite-mcp
npm ci

# Local plan only; no cloud calls.
node scripts/firebase/deploy-mcp-gateway.mjs

# Publish after reviewing the plan.
node scripts/firebase/deploy-mcp-gateway.mjs --apply
```

For subsequent publications, update the clean checkout to reviewed current `main`,
run `npm ci`, and repeat the two script commands. The helper invokes the locked
local CLI with these exact arguments:

```bash
node node_modules/firebase-tools/lib/bin/firebase.js deploy \
  --only hosting --config firebase.mcp.json \
  --project hotel-toolkit --non-interactive
```

`firebase.mcp.json` has only seven exact rewrites to `hotelMcp(us-central1)`:
`/mcp`, `/authorize`, `/token`, `/revoke`,
`/.well-known/oauth-authorization-server`,
`/.well-known/oauth-protected-resource`, and
`/.well-known/oauth-protected-resource/mcp`. The only static asset is
`firebase/mcp-gateway/404.html`. There is no SPA fallback, frontend build hook,
`dist/`, client JavaScript or Firebase web-app configuration. Publication replaces
the live **Hosting** site version; other application paths return 404. The
**App Hosting** frontend remains independent. Use this dedicated configuration,
rather than a root `firebase.json`/`dist` deployment, for the gateway.

The `hotelMcp` Function must already exist. This command does not deploy Functions,
Rules, indexes, TTL, IAM or App Hosting. If MCP is still disabled, gateway MCP
routes return 503 until a successful enabled Functions release.

### Register clients and activate

Use GitHub CLI authenticated as an operator who can manage repository variables
and run the existing workflow. Copy the **exact redirect URI shown by the ChatGPT
app being configured**; do not substitute a guessed callback.

The previous `https://chatgpt.com/connector_platform/oauth/callback` example was
not confirmed and is removed from configuration. On October 15, 2026, the current
[official OpenAI authentication guide](https://developers.openai.com/apps-sdk/build/auth)
could not be fetched because this development environment blocks its host. The
[official authenticated example](https://github.com/openai/openai-apps-sdk-examples/tree/main/authenticated_server_python)
describes discovery/authentication but specifies no fixed ChatGPT callback. Check
the guide and actual client registration at installation; this documentation does
not certify a replacement URI.

```bash
set -euo pipefail

# Prepare while disabled; the next verified Functions release applies variables.
gh variable set HOTEL_MCP_ENABLED --repo SmekensRuben/HotelSuite --body false
gh variable set HOTEL_MCP_PUBLIC_ORIGIN --repo SmekensRuben/HotelSuite \
  --body 'https://hotel-toolkit.web.app'
gh variable set HOTEL_MCP_ALLOWED_ORIGINS_JSON --repo SmekensRuben/HotelSuite \
  --body '[]'

read -r -p 'Paste the exact ChatGPT OAuth redirect URI: ' HOTEL_MCP_CHATGPT_REDIRECT_URI
export HOTEL_MCP_CHATGPT_REDIRECT_URI
python3 - <<'PY' > /tmp/hotel-toolkit-mcp-clients.json
import json, os
from urllib.parse import urlsplit

callback = os.environ["HOTEL_MCP_CHATGPT_REDIRECT_URI"]
parsed = urlsplit(callback)
if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
    raise SystemExit("Copy the exact HTTPS callback from ChatGPT before continuing.")
print(json.dumps([
    {"client_id": "chatgpt-private", "client_name": "ChatGPT (private)",
     "redirect_uris": [callback], "token_endpoint_auth_method": "none"},
    {"client_id": "codex-private", "client_name": "Codex (private)",
     "redirect_uris": ["http://127.0.0.1/callback"], "token_endpoint_auth_method": "none"}
]))
PY
gh variable set HOTEL_MCP_CLIENTS_JSON --repo SmekensRuben/HotelSuite \
  < /tmp/hotel-toolkit-mcp-clients.json

gh variable set HOTEL_MCP_ENABLED --repo SmekensRuben/HotelSuite --body true
gh workflow run deploy-functions.yml --repo SmekensRuben/HotelSuite --ref main
gh run list --repo SmekensRuben/HotelSuite --workflow deploy-functions.yml --limit 1
```

Stop on any error and wait for a successful Functions deployment, not merely a
dispatched/skipped workflow. Existing verified-current-main, keyless identity,
secret metadata and retry controls still apply; the full release has no `--force`.
Setting variables alone does not change a running Function.

Callback matching includes the exact path and query. Codex's current official
source uses `http://127.0.0.1/callback` with an ephemeral port; the maintained SDK
permits only that port variation while retaining scheme, host, path and query.
`localhost` and `127.0.0.1` are different registered hosts. Both clients use public
S256 PKCE without client secrets. Dynamic client registration is not advertised;
the MCP URL alone is insufficient.

The App Hosting origin is allowed automatically. Extra browser origins must be
explicit HTTPS origins; server-to-server clients do not need a CORS exception.
Do not add `*`. Firebase Authentication must allow the existing consent frontend's
domain with its email-verification/MFA policy.

After gateway publication and the enabled Functions release, verify discovery and
the unauthenticated challenge:

```bash
curl --fail --silent --show-error \
  https://hotel-toolkit.web.app/.well-known/oauth-authorization-server
curl --fail --silent --show-error \
  https://hotel-toolkit.web.app/.well-known/oauth-protected-resource/mcp
curl --silent --show-error --dump-header - --output /dev/null \
  https://hotel-toolkit.web.app/mcp
```

Discovery should name the configured issuer/resource and token authentication
method `none`. The final request should return 401 with a `WWW-Authenticate`
resource-metadata challenge. Complete actual ChatGPT/Codex browser consent and
tool checks before expanding the pilot. To disable, set `HOTEL_MCP_ENABLED=false`
and rerun the same verified-main Functions workflow.

Search uses existing `MEILI_HOST`, `MEILI_API_KEY` and `MEILI_INDEX` Secret Manager
bindings. MCP needs no OpenAI API key: the client supplies proposals. Existing
project-wide runtime secret checks remain required by the normal Functions
release. No service-account key or frontend build is needed for gateway
publication. Composite indexes for active personal connections and newest-first
owner batches must be READY. The inventory index helper manages only its four
reviewed inventory indexes.

Enable Firestore TTL on `expiresAt` for root collections
`hotelMcpOAuthAuthorizations`, `hotelMcpOAuthCodes`, `hotelMcpOAuthTokens` and
`hotelMcpOAuthConnections` to reclaim expired OAuth state. Expiry is enforced by
the server even before cleanup. Proposal batches/receipts are durable review
evidence and are not assigned an automatic TTL. All OAuth and proposal collections
deny direct browser reads and writes, including for hotel administrators; generic
file imports cannot target the reserved MCP namespace.

## Connect ChatGPT

1. Enable the private developer/custom-app capability available for your ChatGPT
   workspace. Add a remote MCP app with the canonical HTTPS `/mcp` URL and OAuth.
2. Enter the pre-registered `chatgpt-private` client ID. Leave the client secret
   empty for this public PKCE client. Verify the actual callback against the
   operator configuration before connecting.
3. Complete Hotel Toolkit sign-in and explicitly allow the read/propose access
   shown on the consent page. Consent never approves a product batch.
4. Keep the app private to testing. Workspace app policies, client support and
   plan availability must be checked in that ChatGPT workspace; no public app
   submission is part of this release.

Try: “Prepare these Sligro products for Ghent Marriott. First verify the hotel and
supplier, compare existing physical products and use only existing classifications.
Leave missing prices or units unknown. Stage proposals for my review; do not apply
them.” If several hotels match, the client must ask which one to use.

## Connect Codex

With a current Codex CLI and the matching `codex-private` registration:

```bash
codex mcp add hotel-toolkit \
  --url https://hotel-toolkit.web.app/mcp \
  --oauth-client-id codex-private \
  --oauth-resource https://hotel-toolkit.web.app/mcp
```

The CLI discovers OAuth metadata and starts the browser flow. If explicit consent
or reconnection is needed:

```bash
codex mcp login hotel-toolkit --scopes hotel-toolkit:read,hotel-toolkit:propose
codex mcp list
```

Use `codex mcp login hotel-toolkit --no-browser` when the local client needs to show
the login URL rather than open it. OAuth bearer credentials remain in the client's
credential store; do not paste access tokens into prompts or configuration URLs.
Use normal Codex tool-approval controls for untrusted source material.

Ask: “Use Hotel Toolkit to find my permitted hotel and prepare an update for this
supplier article. Read its current revision first, preserve fields absent from this
source and tell me the resulting proposal batch ID.”

## Revoke, troubleshoot and extend

Open **AI connections** to inspect personal grants and confirm revocation. Local
`codex mcp logout hotel-toolkit` also removes its local authorization. Revoking the
grant in Hotel Toolkit stops both its access and refresh tokens; proposals already
staged remain reviewable. Set `HOTEL_MCP_ENABLED=false` through the reviewed
configuration/release procedure to disable this environment's MCP endpoint.

A `503` indicates disabled or invalid operator configuration. A `401` should
include `WWW-Authenticate` with protected-resource metadata. A scope challenge
requires reconnection/consent; a hotel permission denial requires the hotel rights
or subscription to be corrected. Search unavailability permits listing/detail
fallback. Invalid rows need correction; stale revisions need explicit conflict
review. A pending review must resume its exact original request before another
review command can run. Invalid callback/issuer errors require correcting the
registered client and canonical origin, not bypassing validation.

The implementation is separated into `hotelMcpAuth` (identity/grants),
`hotelMcpServer` (protocol), `hotelMcpAccess` (operational authorization),
`hotelMcpReads`/`hotelMcpTools` (bounded contracts), and `hotelMcpProposals` (durable
review). Future domains should add focused tools and their own permissions.
Platform tools must use an independent platform authorization policy; they cannot
reuse operational hotel discovery or infer access from a platform claim. Orders,
stock mutations, supplier management, direct price auto-approval and arbitrary
uploads remain outside this connection.

## Validation and remaining external checks

Local automated tests cover real HTTP OAuth/PKCE/resource discovery and a maintained
MCP SDK client, strict tool schemas, personal consent/revocation, review/correction,
cross-hotel/user access, revoked accounts/rights, mappings, dependencies, retries,
price evidence and immutable historical records. Real Auth/Firestore/Storage
emulator tests exercise protected rules and transactions. CI commands are unchanged:

```bash
npm test -- --run
npm --prefix functions test
npm run test:security
npm run test:restore
npm run lint
npm run typecheck
npm run audit:policy
npm run build:test
```

An operator still needs to configure and verify public HTTPS Hosting rewrites,
Firebase authorized domains, IAM/secret bindings, READY production-service indexes,
TTL and actual private ChatGPT/Codex login/tool calls. Those hosted browser flows
were not tested in this development environment. Test loss of access while an
already connected client is open, plus a complete stage → human approval → status
round trip, before extending the private pilot.

Official references consulted on October 15, 2026:

- [MCP v1 SDK maintenance policy](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/README.md)
- [Current MCP authorization guidance](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/authorization.md)
- [MCP authorization specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/authorization.mdx)
- [Official OpenAI authenticated MCP example](https://github.com/openai/openai-apps-sdk-examples/tree/main/authenticated_server_python)
- [Official Codex MCP CLI options](https://github.com/openai/codex/blob/main/codex-rs/cli/src/mcp_cmd.rs)
- [Official Codex callback/issuer validation](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/oauth_callback.rs)
- [OpenAI Codex configuration reference](https://developers.openai.com/codex/config-reference)

The developer documentation host was blocked by this cloud environment's network
policy. Current official GitHub documentation and source were consulted for the
authentication and client contracts; hosted client behavior is not inferred from
a successful local SDK test.

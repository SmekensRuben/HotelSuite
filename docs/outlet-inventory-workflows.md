# Outlet inventory workflows

Hotel Toolkit supports a simple outlet count and a more detailed physical-location workflow within the same hotel. A central store is an outlet with the `central_storage` inventory role, so receiving, counts and requisitions use the same stock-point identities.

## Configure once, count with fewer steps

Create an outlet (for example Bar, Breakfast or Main store). Select **Central store** for a storage point that supplies other outlets. A physical location may belong to an outlet, but locations are optional. Existing unlinked locations remain available without moving their historical records.

An outlet's whole-outlet stock point uses the stable identity `outlet:<outletId>`. Detailed locations retain their original document identities. This keeps posted receipts and transfers tied to a physical destination. Do not mix a whole-outlet count and detail-location counts for the same outlet in a single count: the interface and server reject overlapping scope.

Choose the same scope for receiving, movements and comparable opening/closing counts. A whole-outlet checkpoint and a detail-location checkpoint are separate evidence scopes; moving from one workflow to another does not aggregate or rewrite old records automatically.

## Start → count → review

1. Open **Stock Counts → New stock count**. Choose the count type. Ad Hoc offers an optional reason; Month-End asks for month and year and uses the month's final day as its business date. Other counts use the selected business date or the hotel's current business date. The server assigns a useful title, so entering a name is unnecessary.
2. Select outlets and central stores. An outlet counts as a whole by default; enable **Count separate locations** for detail. A template is an optional checklist. Starting empty lets a counter build the list by finding articles during the count.
3. Open a stock-point card. Search for an article, use a keyboard barcode scanner, or open camera scanning when supported. A scan identifies a product; it never increments a quantity or records zero automatically. Resolve ambiguous matches deliberately. Enter the physical quantity in the article's catalog base unit. Package and cost helpers remain optional.
4. Save a draft at any time. Review the uncounted filter before finishing. Finish each stock point, then finish the complete stock count. Completed snapshots remain immutable.

On mobile, the flow uses stacked stock-point cards, touch-size controls and decimal numeric keyboards. Optional accounting detail stays secondary to counting. Unsaved or failed requests remain visible rather than being presented as successful counts.

### Missing is different from empty

A blank quantity is **Uncounted**, not zero. Entering `0` explicitly is **Counted as zero**. Clearing a field returns it to uncounted. Included template rows and added rows must all be explicitly counted before finishing. An empty count cannot establish a useful physical checkpoint.

An empty starting list cannot know which articles an operator forgot to add. Use a template when a complete expected checklist is needed. Adding a product creates a row to review; scanning alone does not prove it was physically checked. The application does not claim completeness for articles outside the chosen list.

## Receiving and requisitions

Receive delivered stock at the chosen outlet stock point or its physical location. For bulk drink deliveries, use the central store as destination. **Inventory movements → Requisition** records a transfer from central storage to an outlet; choose the source and destination, article, positive base quantity and business date, then post the physical movement.

A requisition is the recorded physical issue of goods. It uses the existing atomic transfer command: the source and destination legs commit together, with idempotency and exact compensating reversal evidence. It does not create an approval queue, reserve goods, promise available live stock or deduct hypothetical consumption. The existing inventory period report can include the recorded transfer evidence. Waste, breakage and supplier returns retain their separate categories.

## Permissions and rollout

Stock-count access exposes only the product identities, names, physical units and barcode metadata needed to count. Catalog configuration rights are not required to find articles for an authorized unfinished count. Hotel membership, procurement entitlement, action permissions, current revisions and release gates are checked on the server.

Outlet and location configuration uses protected resource commands. Inventory role and outlet relationships cannot be forged with direct browser writes. All new records stay below the selected hotel; immutable historical count and movement evidence is retained. No production deployment or data migration is performed by this development task. This stock-point contract uses the `saas-platform-v6` release marker; the Functions release gate stays closed while the deployed marker describes an earlier policy. Release the coordinated client, Functions and Rules changes through the repository's reviewed delivery procedure.

const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

// ---------- Params + Secrets (future-proof) ----------
const MEILI_HOST = defineSecret("MEILI_HOST");
const MEILI_INDEX = defineSecret("MEILI_INDEX");
const MEILI_API_KEY = defineSecret("MEILI_API_KEY");


// ---------- Helpers ----------
function requireMeiliHost() {
  const host = (MEILI_HOST.value() || "").trim().replace(/\/$/, "");
  if (!host) throw new Error("Missing MEILI_HOST secret.");
  return host;
}

function getIndexUid() {
  return (MEILI_INDEX.value() || "catalogproducts").trim() || "catalogproducts";
}

async function meiliRequest(path, { method = "GET", body } = {}) {
  const host = requireMeiliHost();
  const apiKey = MEILI_API_KEY.value();

  const res = await fetch(`${host}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  return res;
}

async function meiliJson(path, opts) {
  const res = await meiliRequest(path, opts);
  const text = await res.text();

  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg = typeof data === "string" ? data : JSON.stringify(data ?? {});
    throw new Error(`Meili request failed (${res.status}): ${msg}`);
  }

  return data;
}


// Cache per cold start
const ensuredIndexUids = new Set();

async function ensureIndex(indexUid) {
  if (ensuredIndexUids.has(indexUid)) return;

  const checkRes = await meiliRequest(`/indexes/${encodeURIComponent(indexUid)}`, { method: "GET" });

  if (checkRes.status === 200) {
    ensuredIndexUids.add(indexUid);
    return;
  }

  if (checkRes.status !== 404) {
    const text = await checkRes.text();
    throw new Error(`Index check failed (${checkRes.status}): ${text}`);
  }

  const createRes = await meiliRequest("/indexes", {
    method: "POST",
    body: { uid: indexUid, primaryKey: "id" },
  });

  // 201/202 OK, 409 = race condition (bestaat al)
  if (![201, 202, 409].includes(createRes.status)) {
    const text = await createRes.text();
    throw new Error(`Index create failed (${createRes.status}): ${text}`);
  }

  ensuredIndexUids.add(indexUid);
}


// ---------- Firestore Trigger: syncCatalogProductsToMeili (Gen 2) ----------
exports.syncCatalogProductsToMeili = onDocumentWritten(
  {
    document: "hotels/{hotelUid}/catalogproducts/{productId}",
    secrets: [MEILI_API_KEY, MEILI_HOST, MEILI_INDEX],
  },
  async (event) => {
    const { hotelUid, productId } = event.params;
    const indexUid = getIndexUid();

    await ensureIndex(indexUid);

    // Deleted
    if (!event.data?.after?.exists) {
      const delRes = await meiliRequest(
        `/indexes/${encodeURIComponent(indexUid)}/documents/${encodeURIComponent(productId)}`,
        { method: "DELETE" }
      );

      // 200/202 OK, 404 ok (already gone)
      if (![200, 202, 404].includes(delRes.status)) {
        const text = await delRes.text();
        throw new Error(`Delete failed (${delRes.status}): ${text}`);
      }

      logger.info("Meili delete ok", { indexUid, productId, hotelUid });
      return;
    }

    // Upsert
    const productData = event.data.after.data() || {};
    const doc = {
      id: productId,
      hotelUid,
      // keep it simple for now
      name: productData.name ?? "",
      brand: productData.brand ?? "",
    };

    const result = await meiliJson(`/indexes/${encodeURIComponent(indexUid)}/documents`, {
      method: "POST",
      body: [doc],
    });

    logger.info("Meili upsert enqueued", {
      indexUid,
      productId,
      hotelUid,
      taskUid: result?.taskUid,
    });
  }
);

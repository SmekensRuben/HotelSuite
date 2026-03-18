const { onDocumentWritten, logger, admin, MEILI_API_KEY, MEILI_HOST, MEILI_INDEX, SUPPLIER_PRODUCTS_INDEX_UID } = require("./config");
const { getIndexUid, buildCatalogProductDocument, buildSupplierProductDocument, meiliRequest, meiliJson } = require("./common");

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
const syncCatalogProductsToMeili = onDocumentWritten(
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
    const doc = buildCatalogProductDocument(productId, hotelUid, productData);

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

// ---------- Firestore Trigger: syncSupplierProductsToMeili (Gen 2) ----------
const syncSupplierProductsToMeili = onDocumentWritten(
  {
    document: "hotels/{hotelUid}/supplierproducts/{productId}",
    secrets: [MEILI_API_KEY, MEILI_HOST],
  },
  async (event) => {
    const { hotelUid, productId } = event.params;
    const indexUid = SUPPLIER_PRODUCTS_INDEX_UID;

    await ensureIndex(indexUid);

    if (!event.data?.after?.exists) {
      const delRes = await meiliRequest(
        `/indexes/${encodeURIComponent(indexUid)}/documents/${encodeURIComponent(productId)}`,
        { method: "DELETE" }
      );

      if (![200, 202, 404].includes(delRes.status)) {
        const text = await delRes.text();
        throw new Error(`Delete failed (${delRes.status}): ${text}`);
      }

      logger.info("Meili delete ok", { indexUid, productId, hotelUid });
      return;
    }

    const productData = event.data.after.data() || {};
    const doc = buildSupplierProductDocument(productId, hotelUid, productData);

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

// ---------- Firestore Trigger: syncFileImportSettingsIndex (Gen 2) ----------
const syncFileImportSettingsIndex = onDocumentWritten(
  {
    document: "hotels/{hotelUid}/fileImportSettings/{fileImportSettingId}",
  },
  async (event) => {
    const { hotelUid, fileImportSettingId } = event.params;
    const indexRef = admin.firestore().doc(`fileImportSettingsIndex/${fileImportSettingId}`);

    if (!event.data?.after?.exists) {
      await indexRef.delete();
      logger.info("fileImportSettingsIndex delete ok", {
        fileImportSettingId,
        hotelUid,
      });
      return;
    }

    const data = event.data.after.data() || {};
    await indexRef.set({
      ...data,
      id: fileImportSettingId,
      hotelUid,
    });

    logger.info("fileImportSettingsIndex upsert ok", {
      fileImportSettingId,
      hotelUid,
    });
  }
);

module.exports = {
  syncCatalogProductsToMeili,
  syncSupplierProductsToMeili,
  syncFileImportSettingsIndex,
};

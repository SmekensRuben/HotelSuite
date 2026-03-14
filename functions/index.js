const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { Resend } = require("resend");
const SftpClient = require("ssh2-sftp-client");

if (!admin.apps.length) {
  admin.initializeApp();
}

// ---------- Params + Secrets (future-proof) ----------
const MEILI_HOST = defineSecret("MEILI_HOST");
const MEILI_INDEX = defineSecret("MEILI_INDEX");
const MEILI_API_KEY = defineSecret("MEILI_API_KEY");
const SUPPLIER_PRODUCTS_INDEX_UID = "supplierproducts";
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");
const RESEND_FROM = defineSecret("RESEND_FROM");


// ---------- Helpers ----------
function requireMeiliHost() {
  const host = (MEILI_HOST.value() || "").trim().replace(/\/$/, "");
  if (!host) throw new Error("Missing MEILI_HOST secret.");
  return host;
}

function getIndexUid() {
  return (MEILI_INDEX.value() || "catalogproducts").trim() || "catalogproducts";
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toMillisOrNull(value) {
  if (!value) return null;

  if (typeof value.toMillis === "function") {
    return value.toMillis();
  }

  if (value instanceof Date) {
    const parsed = value.getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (typeof value === "object" && typeof value.seconds === "number") {
    const nanos = typeof value.nanoseconds === "number" ? value.nanoseconds : 0;
    const parsed = (value.seconds * 1000) + Math.floor(nanos / 1000000);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function buildCatalogProductDocument(productId, hotelUid, productData = {}) {
  return {
    id: productId,
    hotelUid,
    name: String(productData.name || "").trim(),
    brand: String(productData.brand || "").trim(),
    gtin: String(productData.gtin || "").trim(),
    internalSku: String(productData.internalSku || "").trim(),
    category: String(productData.category || "").trim(),
    subcategory: String(productData.subcategory || "").trim(),
    active: productData.active !== false,
    imageUrl: String(productData.imageUrl || "").trim(),
    baseQtyPerUnit: toNumberOrNull(productData.baseQtyPerUnit),
    baseUnit: String(productData.baseUnit || "").trim(),
    price: toNumberOrNull(productData.price),
    updatedAt: toMillisOrNull(productData.updatedAt),
  };
}

function buildSupplierProductDocument(productId, hotelUid, productData = {}) {
  return {
    id: productId,
    hotelUid,
    active: productData.active !== false,
    baseUnit: String(productData.baseUnit || "").trim(),
    baseUnitsPerPurchaseUnit: toNumberOrNull(productData.baseUnitsPerPurchaseUnit),
    pricePerPurchaseUnit: toNumberOrNull(productData.pricePerPurchaseUnit),
    supplierId: String(productData.supplierId || "").trim(),
    pricingModel: String(productData.pricingModel || "").trim(),
    priceUpdatedOn: toMillisOrNull(productData.priceUpdatedOn),
    purchaseUnit: String(productData.purchaseUnit || "").trim(),
    imageUrl: String(productData.imageUrl || "").trim(),
    supplierProductName: String(productData.supplierProductName || "").trim(),
    supplierSku: String(productData.supplierSku || "").trim(),
    updatedAt: toMillisOrNull(productData.updatedAt),
  };
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
exports.syncSupplierProductsToMeili = onDocumentWritten(
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


function buildOrderCsv(order = {}) {
  const rows = Array.isArray(order.products) ? order.products : [];
  const headers = [
    "supplierProductId",
    "supplierSku",
    "supplierProductName",
    "qtyPurchaseUnits",
    "purchaseUnit",
    "pricePerPurchaseUnit",
    "currency",
    "deliveryDate",
    "outletId",
  ];

  const escapeCell = (value) => {
    const text = String(value ?? "");
    if (text.includes(",") || text.includes("\"") || text.includes("\n")) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  const body = rows
    .map((item) => [
      item?.supplierProductId || "",
      item?.supplierSku || "",
      item?.supplierProductName || "",
      Number(item?.qtyPurchaseUnits || 0),
      item?.purchaseUnit || "",
      Number(item?.pricePerPurchaseUnit || 0),
      item?.currency || order.currency || "EUR",
      order.deliveryDate || "",
      item?.outletId || "",
    ].map(escapeCell).join(","))
    .join("\n");

  return `${headers.join(",")}\n${body}`;
}

function encodeAttachmentContent(content) {
  if (content === null || content === undefined) return "";
  if (Buffer.isBuffer(content)) return content.toString("base64");
  return Buffer.from(String(content), "utf8").toString("base64");
}

function buildOrderEmailAttachments(order = {}) {
  const csv = buildOrderCsv(order);
  const baseAttachments = [
    {
      filename: `order-${order.id}.csv`,
      content: encodeAttachmentContent(csv),
      contentType: "text/csv",
    },
  ];

  const extraAttachments = Array.isArray(order.emailAttachments) ? order.emailAttachments : [];
  const normalizedExtraAttachments = extraAttachments
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const filename = String(item.filename || item.name || `attachment-${index + 1}`).trim();
      if (!filename) return null;

      const hasBase64 = typeof item.contentBase64 === "string" && item.contentBase64.trim() !== "";
      const content = hasBase64 ? item.contentBase64.trim() : encodeAttachmentContent(item.content || "");

      return {
        filename,
        content,
        contentType: String(item.contentType || item.type || "application/octet-stream").trim(),
      };
    })
    .filter(Boolean);

  return [...baseAttachments, ...normalizedExtraAttachments];
}

function buildOrderEmailPayload(order, supplier) {
  const to = String(supplier?.orderEmail || "").trim();
  if (!to) throw new Error("Supplier heeft geen orderEmail");

  return {
    to: [to],
    subject: `Order ${order.id} - levering ${order.deliveryDate || ""}`,
    text: `Beste ${supplier?.name || "supplier"},\n\nIn bijlage vind je order ${order.id}.\n\nMet vriendelijke groeten`,
    attachments: buildOrderEmailAttachments(order),
  };
}

async function enqueueOrderEmail({ hotelUid, orderId, dispatchRequestId, order, supplier, supplierId }) {
  const mailQueueRef = admin.firestore().collection(`hotels/${hotelUid}/mailQueue`).doc();
  const payload = buildOrderEmailPayload(order, supplier);
  await mailQueueRef.set({
    type: "order-confirmation",
    hotelUid,
    orderId,
    supplierId,
    dispatchRequestId,
    orderRefPath: `hotels/${hotelUid}/orders/${orderId}`,
    status: "queued",
    queuedAt: admin.firestore.FieldValue.serverTimestamp(),
    payload,
  });

  return mailQueueRef.id;
}

async function finalizeOrderDispatchFromMailQueue(mail = {}, updates = {}) {
  const orderRefPath = String(mail.orderRefPath || "").trim();
  const dispatchRequestId = String(mail.dispatchRequestId || "").trim();
  if (!orderRefPath || !dispatchRequestId) return;

  const orderRef = admin.firestore().doc(orderRefPath);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) return;

  const order = orderSnap.data() || {};
  const currentDispatchRequestId = String(order.dispatchRequestId || "").trim();
  const currentDispatchStatus = String(order.dispatchStatus || "").toLowerCase();
  if (currentDispatchRequestId !== dispatchRequestId || currentDispatchStatus !== "processing") return;

  await orderRef.update(updates);
}

exports.processMailQueue = onDocumentCreated(
  {
    document: "hotels/{hotelUid}/mailQueue/{mailId}",
    secrets: [RESEND_API_KEY, RESEND_FROM],
  },
  async (event) => {
    if (!event.data?.exists) return;

    const { hotelUid, mailId } = event.params;
    const mailRef = event.data.ref;
    const mail = event.data.data() || {};
    const status = String(mail.status || "").toLowerCase();
    if (status && status !== "queued") return;

    const resendApiKey = String(RESEND_API_KEY.value() || "").trim();
    const from = String(RESEND_FROM.value() || "").trim();
    if (!resendApiKey) throw new Error("Missing RESEND_API_KEY secret");
    if (!from) throw new Error("Missing RESEND_FROM secret");

    const payload = mail.payload || {};
    const to = Array.isArray(payload.to) ? payload.to.filter(Boolean) : [];
    if (!to.length) throw new Error(`mailQueue/${mailId} heeft geen geldige ontvanger(s)`);

    await mailRef.update({
      status: "processing",
      processingAt: admin.firestore.FieldValue.serverTimestamp(),
      error: admin.firestore.FieldValue.delete(),
    });

    const resend = new Resend(resendApiKey);

    try {
      const response = await resend.emails.send({
        from,
        to,
        cc: Array.isArray(payload.cc) ? payload.cc.filter(Boolean) : undefined,
        bcc: Array.isArray(payload.bcc) ? payload.bcc.filter(Boolean) : undefined,
        replyTo: payload.replyTo || undefined,
        subject: payload.subject || "",
        text: payload.text || undefined,
        html: payload.html || undefined,
        attachments: Array.isArray(payload.attachments) ? payload.attachments : undefined,
      });

      await mailRef.update({
        status: "sent",
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        provider: "resend",
        providerId: String(response?.data?.id || "").trim() || null,
      });

      await finalizeOrderDispatchFromMailQueue(mail, {
        status: "Ordered",
        dispatchStatus: "sent",
        dispatchProgress: 100,
        dispatchStep: "Dispatch completed",
        dispatchedVia: "email",
        dispatchedAt: admin.firestore.FieldValue.serverTimestamp(),
        dispatchError: admin.firestore.FieldValue.delete(),
      });

      logger.info("mailQueue item sent", { hotelUid, mailId, provider: "resend", toCount: to.length });
    } catch (error) {
      await mailRef.update({
        status: "failed",
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
        error: String(error?.message || error),
      });

      await finalizeOrderDispatchFromMailQueue(mail, {
        dispatchStatus: "failed",
        dispatchProgress: 100,
        dispatchStep: "Dispatch failed",
        dispatchError: String(error?.message || error),
        dispatchedVia: admin.firestore.FieldValue.delete(),
        dispatchedAt: admin.firestore.FieldValue.delete(),
      });
      throw error;
    }
  }
);

function resolveSftpConnectionOptions(supplier) {
  const rawAddress = String(supplier?.sftpAddress || "").trim();
  const protocol = String(supplier?.sftpProtocol || "sftp").trim().toLowerCase();
  const user = String(supplier?.sftpUser || "").trim();
  const password = String(supplier?.sftpPassword || "").trim();
  const port = Number(supplier?.sftpPort || 22);

  if (!rawAddress || !user || !password) {
    throw new Error("Onvolledige SFTP instellingen voor supplier");
  }

  let host = rawAddress;
  let remoteDir = "/";

  try {
    const withProtocol = rawAddress.includes("://") ? rawAddress : `${protocol}://${rawAddress}`;
    const parsed = new URL(withProtocol);
    host = parsed.hostname || rawAddress;
    remoteDir = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/";
  } catch (error) {
    const [fallbackHost, ...pathParts] = rawAddress.split("/");
    host = fallbackHost;
    remoteDir = pathParts.length ? `/${pathParts.join("/")}` : "/";
  }

  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 22,
    username: user,
    password,
    remoteDir,
  };
}

async function sendOrderBySftp(order, supplier) {
  const connection = resolveSftpConnectionOptions(supplier);
  const client = new SftpClient();
  const csv = buildOrderCsv(order);

  const safeRemoteDir = connection.remoteDir.endsWith("/") ? connection.remoteDir.slice(0, -1) : connection.remoteDir;
  const remotePath = `${safeRemoteDir || ""}/order-${order.id}.csv`;

  await client.connect({
    host: connection.host,
    port: connection.port,
    username: connection.username,
    password: connection.password,
  });

  try {
    await client.put(Buffer.from(csv, "utf8"), remotePath);
  } finally {
    await client.end();
  }
}

exports.sendOrderedSupplierOrder = onDocumentWritten(
  {
    document: "hotels/{hotelUid}/orders/{orderId}",
    secrets: [RESEND_API_KEY, RESEND_FROM],
  },
  async (event) => {
    if (!event.data?.before?.exists || !event.data?.after?.exists) return;

    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};
    const beforeStatus = String(before.status || "");
    const afterStatus = String(after.status || "");
    const beforeDispatchRequestId = String(before.dispatchRequestId || "").trim();
    const afterDispatchRequestId = String(after.dispatchRequestId || "").trim();

    if (beforeStatus !== "Created" || afterStatus !== "Created") return;
    if (!afterDispatchRequestId || afterDispatchRequestId === beforeDispatchRequestId) return;

    const { hotelUid, orderId } = event.params;
    const orderRef = event.data.after.ref;

    const setProgress = async (progress, step, extra = {}) => {
      await orderRef.update({
        dispatchStatus: "processing",
        dispatchProgress: progress,
        dispatchStep: step,
        ...extra,
      });
      logger.info("Order dispatch progress", { hotelUid, orderId, progress, step });
    };

    const isRequestStillActive = async () => {
      const currentSnap = await orderRef.get();
      const currentData = currentSnap.exists ? (currentSnap.data() || {}) : {};
      const currentRequestId = String(currentData.dispatchRequestId || "").trim();
      const currentDispatchStatus = String(currentData.dispatchStatus || "").toLowerCase();
      return currentRequestId === afterDispatchRequestId && currentDispatchStatus === "processing";
    };

    try {
      await setProgress(10, "Start dispatch request");

      const supplierId = String(after.supplierId || "").trim();
      if (!supplierId) throw new Error(`Order ${orderId} heeft geen supplierId`);

      await setProgress(20, "Loading supplier configuration");
      const supplierRef = admin.firestore().doc(`hotels/${hotelUid}/suppliers/${supplierId}`);
      const supplierSnap = await supplierRef.get();
      if (!supplierSnap.exists) {
        throw new Error(`Supplier niet gevonden voor order ${orderId}: ${supplierId}`);
      }

      const supplier = supplierSnap.data() || {};
      const orderSystem = String(supplier.orderSystem || "Email").trim();

      const orderData = {
        id: orderId,
        ...after,
      };

      let sentVia = "email";
      if (orderSystem === "SFTP csv") {
        await setProgress(45, "Connecting to SFTP");
        await sendOrderBySftp(orderData, supplier);
        sentVia = "sftp";
      } else {
        await setProgress(45, "Queueing email for delivery");
        await enqueueOrderEmail({
          hotelUid,
          orderId,
          dispatchRequestId: afterDispatchRequestId,
          order: orderData,
          supplier,
          supplierId,
        });
        sentVia = "email";
      }

      if (sentVia === "email") {
        await orderRef.update({
          dispatchStatus: "processing",
          dispatchProgress: 70,
          dispatchStep: "Queued for email delivery",
          dispatchError: admin.firestore.FieldValue.delete(),
        });
        logger.info("Order email queued", { hotelUid, orderId, supplierId });
        return;
      }

      const requestStillActive = await isRequestStillActive();
      if (!requestStillActive) {
        logger.warn("Dispatch request no longer active; skipping final status update", {
          hotelUid,
          orderId,
          dispatchRequestId: afterDispatchRequestId,
        });
        return;
      }

      await orderRef.update({
        status: "Ordered",
        dispatchStatus: "sent",
        dispatchProgress: 100,
        dispatchStep: "Dispatch completed",
        dispatchedVia: sentVia,
        dispatchedAt: admin.firestore.FieldValue.serverTimestamp(),
        dispatchError: admin.firestore.FieldValue.delete(),
      });

      logger.info("Order verzonden naar supplier", { hotelUid, orderId, supplierId, sentVia });
    } catch (error) {
      const requestStillActive = await isRequestStillActive();
      if (!requestStillActive) {
        logger.warn("Dispatch failed but request was already marked inactive", {
          hotelUid,
          orderId,
          dispatchRequestId: afterDispatchRequestId,
          error: String(error?.message || error),
        });
        return;
      }

      await orderRef.update({
        dispatchStatus: "failed",
        dispatchProgress: 100,
        dispatchStep: "Dispatch failed",
        dispatchError: String(error?.message || error),
        dispatchedVia: admin.firestore.FieldValue.delete(),
        dispatchedAt: admin.firestore.FieldValue.delete(),
      });
      throw error;
    }
  }
);

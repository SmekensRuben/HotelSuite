const { RESEND_API_KEY, MEILI_HOST, MEILI_INDEX, MEILI_API_KEY } = require("./config");

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

function extractEmailAddress(value) {
  const primitive = typeof value === "object" && value !== null
    ? (value.email || value.address || value.value || "")
    : value;
  const raw = String(primitive || "").trim().toLowerCase();
  if (!raw) return "";
  const match = raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match ? match[0].toLowerCase() : raw;
}

function toEmailList(value) {
  if (Array.isArray(value)) return value.map(extractEmailAddress).filter(Boolean);
  if (typeof value === "object" && value !== null) {
    const single = extractEmailAddress(value);
    return single ? [single] : [];
  }
  return String(value || "")
    .split(/[;,]/)
    .map((item) => extractEmailAddress(item))
    .filter(Boolean);
}

function getFirstAvailableImportAttachment(payload = {}) {
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") continue;

    const filename = String(attachment.filename || attachment.name || "").trim();
    const contentType = String(attachment.contentType || attachment.content_type || attachment.type || "")
      .trim()
      .toLowerCase();

    const lowerFilename = filename.toLowerCase();
    const isCsv = lowerFilename.endsWith(".csv") || contentType.includes("text/csv") || contentType.includes("csv");
    const isTxt = lowerFilename.endsWith(".txt") || contentType.includes("text/plain") || contentType.includes("plain");
    const isXml = lowerFilename.endsWith(".xml") || contentType.includes("application/xml") || contentType.includes("text/xml") || contentType.includes("xml");
    if (!isCsv && !isTxt && !isXml) continue;

    const extension = isTxt ? "txt" : (isXml ? "xml" : "csv");
    const normalizedContentType = isTxt ? "text/plain" : (isXml ? "application/xml" : "text/csv");

    return {
      id: String(attachment.id || attachment.attachmentId || "").trim(),
      filename: filename || `attachment.${extension}`,
      extension,
      contentType: normalizedContentType,
    };
  }

  return null;
}

async function fetchResendAttachmentBuffer(emailData = {}, attachmentId = "") {
  const emailId = String(emailData.email_id || "").trim();
  const normalizedAttachmentId = String(attachmentId || "").trim();

  if (!emailId || !normalizedAttachmentId) {
    throw new Error("Missing email_id or attachmentId for Resend attachment fetch");
  }

  const resendApiKey = (RESEND_API_KEY.value() || "").trim();
  if (!resendApiKey) {
    throw new Error("Missing RESEND_API_KEY secret");
  }

  const endpoint = `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(normalizedAttachmentId)}`;

  const metaResponse = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      Accept: "application/json",
    },
  });

  if (!metaResponse.ok) {
    const responseText = await metaResponse.text();
    throw new Error(`Failed to fetch Resend attachment metadata (${metaResponse.status}): ${responseText}`);
  }

  const metaJson = await metaResponse.json();
  const downloadUrl = String(metaJson?.download_url || "").trim();

  if (!downloadUrl) {
    throw new Error("Resend attachment response missing download_url");
  }

  const downloadResponse = await fetch(downloadUrl, {
    method: "GET",
  });

  if (!downloadResponse.ok) {
    const responseText = await downloadResponse.text();
    throw new Error(`Failed to download Resend attachment (${downloadResponse.status}): ${responseText}`);
  }

  const arrayBuffer = await downloadResponse.arrayBuffer();
  return Buffer.from(arrayBuffer);
}


function normalizeFileType(value) {
  const cleaned = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return cleaned || "csv";
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
    pricePerBaseUnit: toNumberOrNull(productData.pricePerBaseUnit),
    pricePerPurchaseUnit: toNumberOrNull(productData.pricePerPurchaseUnit),
    supplierId: String(productData.supplierId || "").trim(),
    supplierName: String(productData.supplierName || "").trim(),
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

module.exports = {
  requireMeiliHost,
  getIndexUid,
  toNumberOrNull,
  toMillisOrNull,
  extractEmailAddress,
  toEmailList,
  getFirstAvailableImportAttachment,
  fetchResendAttachmentBuffer,
  normalizeFileType,
  buildCatalogProductDocument,
  buildSupplierProductDocument,
  meiliRequest,
  meiliJson,
};

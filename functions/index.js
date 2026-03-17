const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { Resend } = require("resend");
const SftpClient = require("ssh2-sftp-client");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const React = require("react");

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

function getFirstAvailableCsvAttachment(payload = {}) {
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") continue;

    const filename = String(attachment.filename || attachment.name || "").trim();
    const contentType = String(attachment.contentType || attachment.content_type || attachment.type || "")
      .trim()
      .toLowerCase();

    const isCsv = filename.toLowerCase().endsWith(".csv") || contentType.includes("text/csv") || contentType.includes("csv");
    if (!isCsv) continue;

    const contentBase64 = String(
      attachment.contentBase64 || attachment.content || attachment.data || ""
    ).trim();

    if (!contentBase64) continue;

    return {
      filename: filename || "attachment.csv",
      buffer: Buffer.from(contentBase64, "base64"),
    };
  }

  return null;
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

// ---------- Firestore Trigger: syncFileImportSettingsIndex (Gen 2) ----------
exports.syncFileImportSettingsIndex = onDocumentWritten(
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


exports.handleResendEmailReceivedWebhook = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  try {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const emailData = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    const fromEmail = extractEmailAddress(emailData.from || emailData.sender || emailData.fromEmail);
    const toCandidates = [
      ...toEmailList(emailData.to),
      ...toEmailList(emailData.deliveredTo),
      ...toEmailList(emailData.recipient),
    ];
    const toEmailSet = new Set(toCandidates);
    const subject = String(emailData.subject || "").trim().toLowerCase();

    if (!fromEmail || toEmailSet.size === 0 || !subject) {
      res.status(400).json({ error: "Missing from/to/subject in payload" });
      return;
    }

    const csvAttachment = getFirstAvailableCsvAttachment(emailData);
    if (!csvAttachment) {
      res.status(400).json({ error: "No CSV attachment found" });
      return;
    }

    const indexSnapshot = await admin.firestore().collection("fileImportSettingsIndex").get();
    const matchedSetting = indexSnapshot.docs
      .map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }))
      .find((setting) => {
        const settingFrom = extractEmailAddress(setting.fromEmail);
        const settingTo = extractEmailAddress(setting.toEmail);
        const subjectContains = String(setting.subjectContains || setting.subject || "").trim().toLowerCase();

        if (!settingFrom || !settingTo || !subjectContains) return false;
        return settingFrom === fromEmail && toEmailSet.has(settingTo) && subject.includes(subjectContains);
      });

    if (!matchedSetting) {
      res.status(404).json({ error: "No matching file import setting found" });
      return;
    }

    const hotelUid = String(matchedSetting.hotelUid || "").trim();
    if (!hotelUid) {
      res.status(422).json({ error: "Matched setting has no hotelUid" });
      return;
    }

    const fileType = normalizeFileType(matchedSetting.fileType);
    const timestamp = Date.now();
    const storagePath = `imports/${hotelUid}/${fileType}/${timestamp}.csv`;

    const bucket = admin.storage().bucket();
    const file = bucket.file(storagePath);

    await file.save(csvAttachment.buffer, {
      contentType: "text/csv",
      metadata: {
        metadata: {
          hotelUid,
          fileType,
          fromEmail,
          toEmail: Array.from(toEmailSet).join(","),
          subject,
          matchedSettingId: String(matchedSetting.id || ""),
        },
      },
    });

    logger.info("Resend webhook import stored", {
      hotelUid,
      fileType,
      storagePath,
      matchedSettingId: matchedSetting.id,
    });

    res.status(200).json({ ok: true, storagePath, hotelUid, fileType });
  } catch (error) {
    logger.error("handleResendEmailReceivedWebhook failed", { message: error?.message || String(error) });
    res.status(500).json({ error: "Internal Server Error" });
  }
});

function buildOrderCsv(order = {}) {
  const rows = getOrderSupplierProductRows(order);
  const headers = [
    "Supplier",
    "Article Number",
    "Product",
    "Packaging",
    "Price",
    "Quantity",
    "Total Price",
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
      item?.supplier || "",
      item?.supplierSku || "",
      item?.supplierProductName || "",
      item?.purchaseUnit || "",
      Number(item?.pricePerPurchaseUnit || 0),
      Number(item?.qtyPurchaseUnits || 0),
      Number(item?.totalPrice || 0),
    ].map(escapeCell).join(","))
    .join("\n");

  return `${headers.join(",")}\n${body}`;
}

function formatDeliveryDateForSftp(deliveryDate) {
  const raw = String(deliveryDate || "").trim();
  if (!raw) return "";

  const digitsOnly = raw.replace(/\D/g, "");
  if (digitsOnly.length >= 8) return digitsOnly.slice(0, 8);

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function resolveOrderUserEmail(order = {}) {
  const candidates = [
    order.userEmail,
    order.dispatchRequestedByEmail,
    order.requestedByEmail,
    order.updatedByEmail,
    order.createdByEmail,
    order.updatedBy,
    order.createdBy,
    order.email,
  ];

  const found = candidates
    .map((value) => String(value || "").trim())
    .find((value) => value.includes("@"));

  return found || "";
}

function buildSupplierOrderReference(supplierName = "") {
  const now = new Date();
  const year = String(now.getFullYear()).slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  const supplierPrefix = String(supplierName || "")
    .trim()
    .slice(0, 3)
    .padEnd(3, "X");

  return `${year}${month}${day}${supplierPrefix}`;
}

function resolveOrderAccountNumber(order = {}, supplier = {}) {
  const orderAccountNumber = String(order?.accountNumber || "").trim();
  if (orderAccountNumber) return orderAccountNumber;
  return String(supplier?.accountNumber || "").trim();
}

function buildOrderSftpCsv(order = {}, supplier = {}) {
  const rows = Array.isArray(order.products) ? order.products : [];
  const deliveryDate = formatDeliveryDateForSftp(order.deliveryDate);
  const accountNumber = resolveOrderAccountNumber(order, supplier);
  const supplierOrderReference = buildSupplierOrderReference(supplier?.name);
  const userEmail = resolveOrderUserEmail(order);

  const escapeCell = (value) => {
    const text = String(value ?? "");
    if (text.includes(";") || text.includes("\"") || text.includes("\n")) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  return rows
    .map((item) => {
      const pricingModel = String(item?.pricingModel || "").trim();
      const isPerBaseUnit = pricingModel === "Per Base Unit";

      return [
        accountNumber,
        item?.supplierSku || "",
        Number(item?.qtyPurchaseUnits || 0),
        supplierOrderReference,
        isPerBaseUnit ? Number(item?.baseUnitsPerPurchaseUnit || 0) : "",
        isPerBaseUnit ? (item?.baseUnit || "") : "",
        item?.purchaseUnit || "",
        deliveryDate,
        userEmail,
      ].map(escapeCell).join(";");
    })
    .join("\n");
}

function getOrderSupplierProductRows(order = {}) {
  const rows = Array.isArray(order.products) ? order.products : [];
  const supplierName = String(order.supplierName || "").trim();
  return rows.map((item) => ({
    supplier: supplierName || item?.supplierName || "",
    supplierSku: item?.supplierSku || "",
    supplierProductName: item?.supplierProductName || "",
    purchaseUnit: item?.purchaseUnit || "",
    pricePerPurchaseUnit: Number(item?.pricePerPurchaseUnit || 0),
    qtyPurchaseUnits: Number(item?.qtyPurchaseUnits || 0),
    totalPrice: Number(item?.qtyPurchaseUnits || 0) * Number(item?.pricePerPurchaseUnit || 0),
  }));
}

async function buildOrderExcelBuffer(order = {}, supplier = {}, hotel = {}) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Order");
  const supplierRows = getOrderSupplierProductRows(order);
  const currency = String(order.currency || "EUR").trim() || "EUR";
  const exportTitle = buildOrderExportBaseFilename(order, supplier, hotel);

  worksheet.columns = [
    { key: "supplier", width: 28 },
    { key: "supplierSku", width: 20 },
    { key: "supplierProductName", width: 40 },
    { key: "purchaseUnit", width: 20 },
    { key: "pricePerPurchaseUnit", width: 16 },
    { key: "qtyPurchaseUnits", width: 12 },
    { key: "totalPrice", width: 16 },
  ];

  worksheet.mergeCells("A1:G1");
  const titleCell = worksheet.getCell("A1");
  titleCell.value = exportTitle;
  titleCell.font = { size: 16, bold: true };
  titleCell.alignment = { horizontal: "left" };

  worksheet.getCell("A2").value = "Hotel";
  worksheet.getCell("B2").value = String(hotel.hotelName || "");
  worksheet.getCell("A3").value = "Supplier";
  worksheet.getCell("B3").value = String(supplier.name || "");
  worksheet.getCell("A4").value = "Delivery date";
  worksheet.getCell("B4").value = String(order.deliveryDate || "");
  worksheet.getCell("A5").value = "Account number";
  worksheet.getCell("B5").value = resolveOrderAccountNumber(order, supplier);

  ["A2", "A3", "A4", "A5"].forEach((cellRef) => {
    worksheet.getCell(cellRef).font = { bold: true };
  });

  const headerRowIndex = 7;
  const headerRow = worksheet.getRow(headerRowIndex);
  headerRow.values = ["Supplier", "Article Number", "Product", "Packaging", "Price", "Quantity", "Total Price"];
  headerRow.font = { bold: true, color: { argb: "FF1F2937" } };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE8EEF8" },
  };

  supplierRows.forEach((row) => {
    worksheet.addRow({
      supplier: row.supplier,
      supplierSku: row.supplierSku,
      supplierProductName: row.supplierProductName,
      purchaseUnit: row.purchaseUnit,
      pricePerPurchaseUnit: row.pricePerPurchaseUnit,
      qtyPurchaseUnits: row.qtyPurchaseUnits,
      totalPrice: row.totalPrice,
    });
  });

  const firstDataRowIndex = headerRowIndex + 1;
  const lastDataRowIndex = firstDataRowIndex + supplierRows.length - 1;
  if (supplierRows.length > 0) {
    for (let rowIndex = firstDataRowIndex; rowIndex <= lastDataRowIndex; rowIndex += 1) {
      worksheet.getCell(`E${rowIndex}`).numFmt = `#,##0.00 "${currency}"`;
      worksheet.getCell(`G${rowIndex}`).numFmt = `#,##0.00 "${currency}"`;

      const row = worksheet.getRow(rowIndex);
      row.eachCell((cell) => {
        cell.border = {
          top: { style: "thin", color: { argb: "FFE2E8F0" } },
          left: { style: "thin", color: { argb: "FFE2E8F0" } },
          bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
          right: { style: "thin", color: { argb: "FFE2E8F0" } },
        };
      });

      if ((rowIndex - firstDataRowIndex) % 2 === 0) {
        row.eachCell((cell) => {
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFF8FAFC" },
          };
        });
      }
    }
  }

  return workbook.xlsx.writeBuffer();
}

async function buildOrderPdfBuffer(order = {}, supplier = {}, hotel = {}) {
  const doc = new PDFDocument({ margin: 40 });
  const chunks = [];

  return new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const supplierRows = getOrderSupplierProductRows(order);
    const currency = String(order.currency || "EUR").trim() || "EUR";
    const exportTitle = buildOrderExportBaseFilename(order, supplier, hotel);

    doc.fontSize(18).text(exportTitle, { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(12).text(`Hotel: ${hotel.hotelName || ""}`);
    doc.text(`Supplier: ${supplier.name || ""}`);
    doc.text(`Delivery date: ${order.deliveryDate || ""}`);
    doc.text(`Account number: ${resolveOrderAccountNumber(order, supplier)}`);
    doc.moveDown();

    const columns = [
      { key: "supplier", label: "Supplier", width: 90, align: "left" },
      { key: "supplierSku", label: "Article Number", width: 85, align: "left" },
      { key: "supplierProductName", label: "Product", width: 130, align: "left" },
      { key: "purchaseUnit", label: "Packaging", width: 60, align: "left" },
      { key: "pricePerPurchaseUnit", label: "Price", width: 55, align: "right" },
      { key: "qtyPurchaseUnits", label: "Quantity", width: 45, align: "right" },
      { key: "totalPrice", label: "Total Price", width: 65, align: "right" },
    ];

    const startX = doc.page.margins.left;
    let y = doc.y;
    const tableWidth = columns.reduce((sum, col) => sum + col.width, 0);
    const rowHeight = 20;

    const drawHeader = () => {
      doc.rect(startX, y, tableWidth, rowHeight).fill("#E8EEF8");
      let x = startX;
      doc.fillColor("#1F2937").font("Helvetica-Bold").fontSize(9);
      columns.forEach((column) => {
        doc.text(column.label, x + 4, y + 6, { width: column.width - 8, align: column.align || "left" });
        doc.rect(x, y, column.width, rowHeight).stroke("#CBD5E1");
        x += column.width;
      });
      y += rowHeight;
    };

    drawHeader();

    doc.font("Helvetica").fontSize(9);
    supplierRows.forEach((row, index) => {
      if (y > doc.page.height - 80) {
        doc.addPage();
        y = doc.page.margins.top;
        drawHeader();
      }

      if (index % 2 === 0) {
        doc.rect(startX, y, tableWidth, rowHeight).fill("#F8FAFC");
      }

      let x = startX;
      const values = {
        ...row,
        pricePerPurchaseUnit: `${Number(row.pricePerPurchaseUnit || 0).toFixed(2)} ${currency}`,
        qtyPurchaseUnits: Number(row.qtyPurchaseUnits || 0),
        totalPrice: `${Number(row.totalPrice || 0).toFixed(2)} ${currency}`,
      };

      columns.forEach((column) => {
        doc.fillColor("#111827").text(String(values[column.key] || ""), x + 4, y + 6, {
          width: column.width - 8,
          align: column.align || "left",
          ellipsis: true,
        });
        doc.rect(x, y, column.width, rowHeight).stroke("#E2E8F0");
        x += column.width;
      });

      y += rowHeight;
    });

    doc.end();
  });
}

function encodeAttachmentContent(content) {
  if (content === null || content === undefined) return "";
  if (Buffer.isBuffer(content)) return content.toString("base64");
  return Buffer.from(String(content), "utf8").toString("base64");
}

async function buildOrderEmailAttachments(order = {}, supplier = {}, hotel = {}) {
  const excelBuffer = await buildOrderExcelBuffer(order, supplier, hotel);
  const pdfBuffer = await buildOrderPdfBuffer(order, supplier, hotel);
  const baseFilename = buildOrderExportBaseFilename(order, supplier, hotel);
  const baseAttachments = [
    {
      filename: `${baseFilename}.xlsx`,
      content: encodeAttachmentContent(excelBuffer),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    {
      filename: `${baseFilename}.pdf`,
      content: encodeAttachmentContent(pdfBuffer),
      contentType: "application/pdf",
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

function sanitizeFilenameSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

function buildOrderExportBaseFilename(order = {}, supplier = {}, hotel = {}) {
  const hotelName = sanitizeFilenameSegment(hotel.hotelName);
  const accountNumber = sanitizeFilenameSegment(resolveOrderAccountNumber(order, supplier));
  const deliveryDate = sanitizeFilenameSegment(order.deliveryDate);

  return [hotelName || "Hotel", accountNumber || "Account", deliveryDate || "Delivery date"].join(" - ");
}

async function buildOrderEmailPayload(order, supplier, hotel) {
  const to = String(supplier?.orderEmail || "").trim();
  if (!to) throw new Error("Supplier heeft geen orderEmail");

  const accountNumber = resolveOrderAccountNumber(order, supplier);
  const hotelName = String(hotel?.hotelName || "").trim();
  const supplierName = String(supplier?.name || "").trim();
  const deliveryDate = String(order?.deliveryDate || "").trim();

  return {
    to: [to],
    subject: `${accountNumber} - ${hotelName} - Order ${supplierName} - Delivery ${deliveryDate}`,
    text: `Beste ${supplier?.name || "supplier"},

In bijlage vind je de order voor:
- Hotel: ${hotelName || "-"}
- Accountnummer: ${accountNumber || "-"}
- Leverdatum: ${deliveryDate || "-"}

Met vriendelijke groeten`,
    attachments: await buildOrderEmailAttachments(order, supplier, hotel),
  };
}

async function enqueueOrderEmail({ hotelUid, orderId, dispatchRequestId, order, supplier, supplierId, hotel }) {
  const mailQueueRef = admin.firestore().collection(`hotels/${hotelUid}/mailQueue`).doc();
  const payload = await buildOrderEmailPayload(order, supplier, hotel);
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


function toDateOnly(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function diffInDaysUtc(fromDate, toDate) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((toDate.getTime() - fromDate.getTime()) / msPerDay);
}

function sanitizeReminderDays(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((day) => Number(day))
      .filter((day) => Number.isFinite(day) && day >= 0)
      .map((day) => Math.floor(day))
  )];
}

function ContractReminderEmailTemplate({ hotelName, contractId, contractName, endDate, cancelBefore, daysUntilCancel, contractDetailUrl }) {
  const headline = contractName || contractId;

  return React.createElement(
    "div",
    {
      style: {
        backgroundColor: "#f3f4f6",
        fontFamily: "Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif",
        padding: "24px 0",
      },
    },
    React.createElement(
      "table",
      {
        role: "presentation",
        cellPadding: "0",
        cellSpacing: "0",
        width: "100%",
        style: {
          maxWidth: "640px",
          margin: "0 auto",
          backgroundColor: "#ffffff",
          border: "1px solid #e5e7eb",
        },
      },
      React.createElement(
        "tbody",
        null,
        React.createElement(
          "tr",
          null,
          React.createElement(
            "td",
            {
              bgColor: "#8f1b1b",
              style: {
                backgroundColor: "#8f1b1b",
                backgroundImage: "linear-gradient(90deg,#b41f1f,#7f1717)",
                color: "#ffffff",
                padding: "24px",
              },
            },
            React.createElement(
              "p",
              {
                style: {
                  margin: "0 0 6px",
                  fontSize: "12px",
                  lineHeight: "18px",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "#ffffff",
                  opacity: 0.95,
                },
              },
              "Contract reminder"
            ),
            React.createElement(
              "h1",
              {
                style: {
                  margin: 0,
                  fontSize: "24px",
                  lineHeight: "30px",
                  color: "#ffffff",
                  fontWeight: 700,
                },
              },
              headline
            )
          )
        ),
        React.createElement(
          "tr",
          null,
          React.createElement(
            "td",
            { style: { backgroundColor: "#ffffff", padding: "24px" } },
            React.createElement(
              "p",
              { style: { margin: "0 0 16px", fontSize: "14px", lineHeight: "20px", color: "#111827" } },
              "A contract needs attention for ",
              React.createElement("strong", { style: { color: "#111827" } }, hotelName || "Hotel"),
              "."
            ),
            React.createElement(
              "table",
              {
                role: "presentation",
                cellPadding: "0",
                cellSpacing: "0",
                width: "100%",
                style: { borderCollapse: "collapse", marginBottom: "22px", backgroundColor: "#ffffff" },
              },
              React.createElement(
                "tbody",
                null,
                ...[
                  ["Hotel", hotelName || "-"],
                  ["Contract", headline || "-"],
                  ["End date", endDate || "-"],
                  ["Cancel before", cancelBefore || "-"],
                  ["Days until cancel-before", String(daysUntilCancel)],
                ].map(([label, value]) =>
                  React.createElement(
                    "tr",
                    { key: label },
                    React.createElement(
                      "td",
                      {
                        style: {
                          padding: "8px 0",
                          fontSize: "13px",
                          lineHeight: "18px",
                          color: "#4b5563",
                          width: "190px",
                          backgroundColor: "#ffffff",
                        },
                      },
                      label
                    ),
                    React.createElement(
                      "td",
                      {
                        style: {
                          padding: "8px 0",
                          fontSize: "13px",
                          lineHeight: "18px",
                          color: "#111827",
                          fontWeight: 600,
                          backgroundColor: "#ffffff",
                        },
                      },
                      value
                    )
                  )
                )
              )
            ),
            React.createElement(
              "table",
              {
                role: "presentation",
                cellPadding: "0",
                cellSpacing: "0",
                style: { borderCollapse: "separate" },
              },
              React.createElement(
                "tbody",
                null,
                React.createElement(
                  "tr",
                  null,
                  React.createElement(
                    "td",
                    {
                      bgColor: "#b41f1f",
                      style: {
                        backgroundColor: "#b41f1f",
                        borderRadius: "8px",
                        padding: "0",
                      },
                    },
                    React.createElement(
                      "a",
                      {
                        href: contractDetailUrl,
                        style: {
                          display: "inline-block",
                          padding: "12px 20px",
                          lineHeight: "20px",
                          backgroundColor: "#b41f1f",
                          color: "#ffffff",
                          textDecoration: "none",
                          fontSize: "14px",
                          fontWeight: 700,
                          borderRadius: "8px",
                        },
                      },
                      "Open contract"
                    )
                  )
                )
              )
            )
          )
        )
      )
    )
  );
}


const hotelNameCache = new Map();

async function resolveHotelName(hotelUid) {
  const normalizedHotelUid = String(hotelUid || "").trim();
  if (!normalizedHotelUid) return "Hotel";
  if (hotelNameCache.has(normalizedHotelUid)) return hotelNameCache.get(normalizedHotelUid);

  const hotelSnap = await admin.firestore().doc(`hotels/${normalizedHotelUid}`).get();
  const hotelData = hotelSnap.exists ? (hotelSnap.data() || {}) : {};
  const hotelName = String(hotelData.hotelName || "").trim() || normalizedHotelUid;
  hotelNameCache.set(normalizedHotelUid, hotelName);
  return hotelName;
}

async function sendContractReminderEmail({ to, hotelName, contractId, contractName, endDate, cancelBefore, daysUntilCancel }) {
  const resendApiKey = String(RESEND_API_KEY.value() || "").trim();
  const from = String(RESEND_FROM.value() || "").trim();
  if (!resendApiKey) throw new Error("Missing RESEND_API_KEY secret");
  if (!from) throw new Error("Missing RESEND_FROM secret");

  const resend = new Resend(resendApiKey);

  const contractDetailUrl = `https://hoteltoolkit.eu/contracts/${contractId}`;

  await resend.emails.send({
    from,
    to,
    subject: `Contract reminder: ${contractName || contractId}`,
    text: `Contract reminder

Hotel: ${hotelName || "-"}
Contract: ${contractName || contractId}
End date: ${endDate || "-"}
Cancel before: ${cancelBefore || "-"}
Days until cancel-before: ${daysUntilCancel}
Contract link: ${contractDetailUrl}`,
    react: React.createElement(ContractReminderEmailTemplate, {
      hotelName,
      contractId,
      contractName,
      endDate,
      cancelBefore,
      daysUntilCancel,
      contractDetailUrl,
    }),
  });
}

async function processContractCancellationReminders({ hotelUidFilter } = {}) {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const contractsSnap = hotelUidFilter
    ? await admin.firestore().collection(`hotels/${hotelUidFilter}/contracts`).get()
    : await admin.firestore().collectionGroup("contracts").get();

  for (const contractDoc of contractsSnap.docs) {
    const contract = contractDoc.data() || {};
    const pathSegments = contractDoc.ref.path.split("/");
    const hotelUid = hotelUidFilter || pathSegments[1] || "unknown-hotel";
    const hotelName = await resolveHotelName(hotelUid);
    const cancelBefore = toDateOnly(contract.cancelBefore);

    if (!cancelBefore) {
      logger.info("Contract reminder scan (skipped: missing cancelBefore)", {
        hotelUid,
        hotelName,
        contractId: contractDoc.id,
        contractName: String(contract.name || "").trim() || null,
      });
      continue;
    }

    const reminderDays = sanitizeReminderDays(contract.reminderDays);
    const daysUntilCancel = diffInDaysUtc(todayUtc, cancelBefore);

    logger.info("Contract reminder scan", {
      hotelUid,
      hotelName,
      contractId: contractDoc.id,
      contractName: String(contract.name || "").trim() || null,
      cancelBefore: String(contract.cancelBefore || "").trim() || null,
      daysUntilCancel,
      reminderDays,
    });

    if (!reminderDays.length) continue;
    if (!reminderDays.includes(daysUntilCancel)) continue;

    const followers = Array.isArray(contract.followers) ? contract.followers : [];
    const to = [...new Set(followers.map((follower) => String(follower?.email || "").trim()).filter(Boolean))];
    if (!to.length) continue;

    await sendContractReminderEmail({
      to,
      hotelName,
      contractId: contractDoc.id,
      contractName: String(contract.name || "").trim(),
      endDate: String(contract.endDate || "").trim(),
      cancelBefore: String(contract.cancelBefore || "").trim(),
      daysUntilCancel,
    });

    logger.info("Contract reminder email sent", {
      hotelUid,
      hotelName,
      contractId: contractDoc.id,
      daysUntilCancel,
      recipients: to.length,
    });
  }
}

exports.sendContractCancellationReminders = onSchedule(
  {
    schedule: "0 6 * * *",
    timeZone: "Europe/Brussels",
    secrets: [RESEND_API_KEY, RESEND_FROM],
  },
  async () => {
    await processContractCancellationReminders();
  }
);

exports.runContractCancellationRemindersNow = onDocumentCreated(
  {
    document: "hotels/{hotelUid}/contractReminderRuns/{runId}",
    secrets: [RESEND_API_KEY, RESEND_FROM],
  },
  async (event) => {
    if (!event.data?.exists) return;

    const { hotelUid, runId } = event.params;
    const runRef = event.data.ref;

    await runRef.update({
      status: "processing",
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      error: admin.firestore.FieldValue.delete(),
    });

    try {
      await processContractCancellationReminders({ hotelUidFilter: hotelUid });
      await runRef.update({
        status: "completed",
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      logger.info("Manual contract reminders run completed", { hotelUid, runId });
    } catch (error) {
      await runRef.update({
        status: "failed",
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
        error: String(error?.message || error),
      });
      throw error;
    }
  }
);


function OrderApprovalRequestEmailTemplate({ hotelName, outletName, orderId, supplierName, deliveryDate, orderDetailUrl }) {
  return React.createElement(
    "div",
    {
      style: {
        backgroundColor: "#f3f4f6",
        fontFamily: "Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif",
        padding: "24px 0",
      },
    },
    React.createElement(
      "table",
      {
        role: "presentation",
        cellPadding: "0",
        cellSpacing: "0",
        width: "100%",
        style: {
          maxWidth: "640px",
          margin: "0 auto",
          backgroundColor: "#ffffff",
          border: "1px solid #e5e7eb",
        },
      },
      React.createElement(
        "tbody",
        null,
        React.createElement(
          "tr",
          null,
          React.createElement(
            "td",
            {
              bgColor: "#8f1b1b",
              style: {
                backgroundColor: "#8f1b1b",
                backgroundImage: "linear-gradient(90deg,#b41f1f,#7f1717)",
                color: "#ffffff",
                padding: "24px",
              },
            },
            React.createElement(
              "p",
              {
                style: {
                  margin: "0 0 6px",
                  fontSize: "12px",
                  lineHeight: "18px",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "#ffffff",
                  opacity: 0.95,
                },
              },
              "Order approval needed"
            ),
            React.createElement(
              "h1",
              {
                style: {
                  margin: 0,
                  fontSize: "24px",
                  lineHeight: "30px",
                  color: "#ffffff",
                  fontWeight: 700,
                },
              },
              `Order ${orderId}`
            )
          )
        ),
        React.createElement(
          "tr",
          null,
          React.createElement(
            "td",
            { style: { backgroundColor: "#ffffff", padding: "24px" } },
            React.createElement(
              "p",
              { style: { margin: "0 0 16px", fontSize: "14px", lineHeight: "20px", color: "#111827" } },
              "An order is waiting for your confirmation."
            ),
            React.createElement(
              "table",
              {
                role: "presentation",
                cellPadding: "0",
                cellSpacing: "0",
                width: "100%",
                style: { borderCollapse: "collapse", marginBottom: "22px", backgroundColor: "#ffffff" },
              },
              React.createElement(
                "tbody",
                null,
                ...[
                  ["Hotel", hotelName || "-"],
                  ["Outlet", outletName || "-"],
                  ["Supplier", supplierName || "-"],
                  ["Order ID", orderId || "-"],
                  ["Delivery date", deliveryDate || "-"],
                ].map(([label, value]) =>
                  React.createElement(
                    "tr",
                    { key: label },
                    React.createElement(
                      "td",
                      {
                        style: {
                          padding: "8px 0",
                          fontSize: "13px",
                          lineHeight: "18px",
                          color: "#4b5563",
                          width: "190px",
                          backgroundColor: "#ffffff",
                        },
                      },
                      label
                    ),
                    React.createElement(
                      "td",
                      {
                        style: {
                          padding: "8px 0",
                          fontSize: "13px",
                          lineHeight: "18px",
                          color: "#111827",
                          fontWeight: 600,
                          backgroundColor: "#ffffff",
                        },
                      },
                      value
                    )
                  )
                )
              )
            ),
            React.createElement(
              "table",
              {
                role: "presentation",
                cellPadding: "0",
                cellSpacing: "0",
                style: { borderCollapse: "separate" },
              },
              React.createElement(
                "tbody",
                null,
                React.createElement(
                  "tr",
                  null,
                  React.createElement(
                    "td",
                    {
                      bgColor: "#b41f1f",
                      style: {
                        backgroundColor: "#b41f1f",
                        borderRadius: "8px",
                      },
                    },
                    React.createElement(
                      "a",
                      {
                        href: orderDetailUrl,
                        target: "_blank",
                        rel: "noreferrer",
                        style: {
                          display: "inline-block",
                          padding: "12px 18px",
                          fontSize: "14px",
                          color: "#ffffff",
                          fontWeight: 700,
                          textDecoration: "none",
                          borderRadius: "8px",
                        },
                      },
                      "Open order"
                    )
                  )
                )
              )
            )
          )
        )
      )
    )
  );
}

exports.sendOrderApprovalEmailToApprovers = onDocumentCreated(
  {
    document: "hotels/{hotelUid}/orders/{orderId}",
    secrets: [RESEND_API_KEY, RESEND_FROM],
  },
  async (event) => {
    if (!event.data?.exists) return;

    const { hotelUid, orderId } = event.params;
    const order = event.data.data() || {};
    const outletId = String(order.outletId || "").trim();
    if (!outletId) return;

    const approversSnap = await admin.firestore().collection(`hotels/${hotelUid}/outlets/${outletId}/approvers`).get();
    const to = [...new Set(
      approversSnap.docs
        .map((docSnap) => String((docSnap.data() || {}).email || "").trim())
        .filter(Boolean)
    )];

    if (!to.length) {
      logger.info("No approvers with email found for outlet", { hotelUid, outletId, orderId });
      return;
    }

    const resendApiKey = String(RESEND_API_KEY.value() || "").trim();
    const from = String(RESEND_FROM.value() || "").trim();
    if (!resendApiKey) throw new Error("Missing RESEND_API_KEY secret");
    if (!from) throw new Error("Missing RESEND_FROM secret");

    const hotelName = await resolveHotelName(hotelUid);
    const resend = new Resend(resendApiKey);
    const orderDetailUrl = `https://hoteltoolkit.eu/orders/${orderId}`;

    await resend.emails.send({
      from,
      to,
      subject: `Order approval required: ${orderId}`,
      text: `Order approval needed

Hotel: ${hotelName || "-"}
Outlet: ${String(order.outletName || "").trim() || "-"}
Supplier: ${String(order.supplierName || order.supplierId || "").trim() || "-"}
Order ID: ${orderId}
Delivery date: ${String(order.deliveryDate || "").trim() || "-"}
Open order: ${orderDetailUrl}`,
      react: React.createElement(OrderApprovalRequestEmailTemplate, {
        hotelName,
        outletName: String(order.outletName || "").trim(),
        orderId,
        supplierName: String(order.supplierName || order.supplierId || "").trim(),
        deliveryDate: String(order.deliveryDate || "").trim(),
        orderDetailUrl,
      }),
    });

    logger.info("Order approval email sent", {
      hotelUid,
      outletId,
      orderId,
      recipients: to.length,
    });
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

async function sendOrderBySftp(order, supplier, context = {}) {
  const connection = resolveSftpConnectionOptions(supplier);
  const client = new SftpClient();
  const csv = buildOrderSftpCsv(order, supplier);
  const logContext = {
    hotelUid: String(context.hotelUid || "").trim(),
    orderId: String(context.orderId || order.id || "").trim(),
    supplierId: String(context.supplierId || supplier.id || "").trim(),
    host: connection.host,
    port: connection.port,
    remoteDir: connection.remoteDir,
  };

  const safeRemoteDir = connection.remoteDir.endsWith("/") ? connection.remoteDir.slice(0, -1) : connection.remoteDir;
  const baseFilename = buildOrderExportBaseFilename(order, supplier, { hotelName: order.hotelName });
  const remotePath = `${safeRemoteDir || ""}/${baseFilename}.csv`;

  const logDirectoryList = async (pathToList, label) => {
    try {
      const entries = await client.list(pathToList);
      logger.info("SFTP directory listing", {
        ...logContext,
        label,
        path: pathToList,
        entryCount: entries.length,
        entries: entries.slice(0, 50).map((entry) => ({
          name: entry?.name,
          type: entry?.type,
          size: entry?.size,
          modifyTime: entry?.modifyTime,
        })),
      });
    } catch (error) {
      logger.warn("SFTP directory listing failed", {
        ...logContext,
        label,
        path: pathToList,
        error: String(error?.message || error),
      });
    }
  };

  logger.info("SFTP connect attempt", { ...logContext, remotePath });

  await client.connect({
    host: connection.host,
    port: connection.port,
    username: connection.username,
    password: connection.password,
  });

  try {
    try {
      const cwd = await client.cwd();
      logger.info("SFTP connected", { ...logContext, cwd, remotePath });
    } catch (error) {
      logger.warn("SFTP cwd lookup failed", { ...logContext, error: String(error?.message || error) });
    }

    await logDirectoryList("/", "root");
    await logDirectoryList(connection.remoteDir || "/", "configured-remote-dir");

    const parentDir = safeRemoteDir && safeRemoteDir.includes("/")
      ? safeRemoteDir.slice(0, safeRemoteDir.lastIndexOf("/")) || "/"
      : "/";
    await logDirectoryList(parentDir, "remote-parent-dir");

    logger.info("SFTP upload start", { ...logContext, remotePath, bytes: Buffer.byteLength(csv, "utf8") });
    await client.put(Buffer.from(csv, "utf8"), remotePath);
    logger.info("SFTP upload success", { ...logContext, remotePath });
  } catch (error) {
    logger.error("SFTP upload failed", {
      ...logContext,
      remotePath,
      error: String(error?.message || error),
      code: error?.code || null,
    });
    throw error;
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
      const hotelRef = admin.firestore().doc(`hotels/${hotelUid}`);
      const hotelSnap = await hotelRef.get();
      const hotel = hotelSnap.exists ? (hotelSnap.data() || {}) : {};
      const orderSystem = String(supplier.orderSystem || "Email").trim();

      const orderData = {
        id: orderId,
        supplierName: String(supplier.name || "").trim(),
        hotelName: String(hotel.hotelName || "").trim(),
        ...after,
      };

      let sentVia = "email";
      if (orderSystem === "SFTP csv") {
        await setProgress(45, "Connecting to SFTP");
        await sendOrderBySftp(orderData, supplier, { hotelUid, orderId, supplierId });
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
          hotel,
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

const { onDocumentCreated, logger, admin, Resend, ExcelJS, PDFDocument, RESEND_API_KEY, RESEND_FROM } = require("./config");
const { hotelHasActiveSubscription } = require("./subscriptions");

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
  const supplierOrderReference = order.supplierOrderReference || order.id || buildSupplierOrderReference(supplier?.name);
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


function sanitizeEmails(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || "")
      .split(/[;,\n]/)
      .map((entry) => entry.trim());

  return values
    .map((entry) => String(entry || "").trim())
    .filter((entry) => entry && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry));
}

function sanitizeFilenameSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}


function buildOrderNotesOverview(order = {}) {
  const rows = Array.isArray(order.products) ? order.products : [];
  const noteRows = rows
    .map((item) => ({
      product: String(item?.supplierProductName || item?.productName || item?.supplierSku || "Unknown product").trim(),
      note: String(item?.note || "").trim(),
    }))
    .filter((item) => item.note);

  if (!noteRows.length) return "";

  const lines = ["", "Product notes overview:"];
  noteRows.forEach((item) => {
    lines.push(`- ${item.product}: ${item.note}`);
  });

  return lines.join("\n");
}

function buildOrderExportBaseFilename(order = {}, supplier = {}, hotel = {}) {
  const hotelName = sanitizeFilenameSegment(hotel.hotelName);
  const accountNumber = sanitizeFilenameSegment(resolveOrderAccountNumber(order, supplier));
  const deliveryDate = sanitizeFilenameSegment(order.deliveryDate);

  return [hotelName || "Hotel", accountNumber || "Account", deliveryDate || "Delivery date"].join(" - ");
}

async function buildOrderEmailPayload(order, supplier, hotel) {
  const to = String(supplier?.orderEmail || "").trim();
  if (!to) throw new Error("Configure the supplier order email.");

  const accountNumber = resolveOrderAccountNumber(order, supplier);
  const hotelName = String(hotel?.hotelName || "").trim();
  const supplierName = String(supplier?.name || "").trim();
  const deliveryDate = String(order?.deliveryDate || "").trim();
  const outletName = String(order?.outletName || order?.outletId || "").trim();

  const notesOverview = buildOrderNotesOverview(order);

  const cc = sanitizeEmails(supplier?.orderEmailCc || supplier?.orderEmailCC);

  return {
    to: [to],
    cc,
    subject: `${accountNumber} - ${hotelName} - Outlet ${outletName || "-"} - Order ${supplierName} - Delivery ${deliveryDate}`,
    text: `Dear ${supplier?.name || "supplier"},

Please find the order attached:
- Hotel: ${hotelName || "-"}
- Outlet: ${outletName || "-"}
- Account number: ${accountNumber || "-"}
- Delivery date: ${deliveryDate || "-"}${notesOverview}

Kind regards`,
    attachments: await buildOrderEmailAttachments(order, supplier, hotel),
  };
}

async function enqueueOrderEmail({ hotelUid, orderId, dispatchRequestId, order, supplier, supplierId, hotel }, services = {}) {
  const db = services.firestore || admin.firestore();
  const { digest } = require("./validation");
  const ref = db.doc(`hotels/${hotelUid}/mailQueue/order-${digest(orderId, dispatchRequestId)}`);
  if ((await ref.get()).exists) return ref.id;
  const payload = await buildOrderEmailPayload(order, supplier, hotel);
  await db.runTransaction(async (tx) => {
    const dispatchRef = db.doc(`hotels/${hotelUid}/dispatches/${dispatchRequestId}`);
    const [current, dispatch, currentOrder] = await Promise.all([tx.get(ref), tx.get(dispatchRef), tx.get(db.doc(`hotels/${hotelUid}/orders/${orderId}`))]);
    if (current.exists) return;
    if (!dispatch.exists || dispatch.data().status !== "processing" || dispatch.data().orderId !== orderId
      || currentOrder.data()?.dispatchRequestId !== dispatchRequestId) throw new Error("This delivery is no longer awaiting email preparation.");
    // Queue state and outbox creation commit together. A fast mail worker must
    // never have its processing state overwritten by the dispatch trigger.
    tx.update(dispatchRef, { status: "queued" });
    tx.create(ref, { type: "order-confirmation", hotelUid, orderId, supplierId,
      dispatchRequestId, status: "queued", queuedAt: admin.firestore.FieldValue.serverTimestamp(), payload });
  });
  return ref.id;
}

async function processMailQueueHandler(event, services = {}) {
  if (!event.data?.exists) return;
  const { hotelUid, mailId } = event.params;
  const db = services.firestore || admin.firestore();
  const ref = db.doc(`hotels/${hotelUid}/mailQueue/${mailId}`);
  const { subscriptionIsActive } = require("./subscriptions");
  const { completeDispatch, dispatchActorIsCurrent } = require("./deliveryState");
  const { digest } = require("./validation");
  const mail = await db.runTransaction(async (tx) => {
    const [current, subscription] = await Promise.all([tx.get(ref), tx.get(db.doc(`hotelSubscriptions/${hotelUid}`))]);
    if (!current.exists || current.data().status !== "queued") return null;
    const data = current.data();
    let permitted = data.hotelUid === hotelUid;
    if (data.type === "hotel-invitation") {
      const { requireDocumentId } = require("./subscriptions");
      try {
        requireDocumentId(data.uid, "Invitee UID");
        const member = await tx.get(db.doc(`hotels/${hotelUid}/members/${data.uid}`));
        const user = await (services.auth || admin.auth()).getUser(data.uid);
        const actor = await (services.auth || admin.auth()).getUser(requireDocumentId(data.actorUid, "Invitation actor UID"));
        permitted = permitted && !actor.disabled && actor.emailVerified === true && actor.customClaims?.platformAdmin === true && member.exists && !user.disabled && data.payload?.to?.length === 1 && data.payload.to[0] === user.email;
      } catch { permitted = false; }
    }
    if (data.type === "order-approval") {
      const { permissionAllows, normalizedPermissions } = require("./authorization");
      const { requireDocumentId } = require("./subscriptions");
      try {
        if (!Array.isArray(data.recipientUids) || !data.recipientUids.length || data.recipientUids.length > 20) permitted = false;
        else {
          const ids = data.recipientUids.map((id) => requireDocumentId(id, "Approver UID"));
          const members = await tx.getAll(...ids.map((id) => db.doc(`hotels/${hotelUid}/members/${id}`)));
          const users = await Promise.all(ids.map((id) => (services.auth || admin.auth()).getUser(id)));
          const order = await tx.get(db.doc(`hotels/${hotelUid}/orders/${requireDocumentId(data.orderId, "Order ID")}`));
          const currentOrder = order.data();
          const approvers = order.exists && currentOrder?.outletId ? await tx.getAll(...ids.map((id) => db.doc(`hotels/${hotelUid}/outlets/${currentOrder.outletId}/approvers/${id}`))) : [];
          permitted = permitted && order.exists && currentOrder.status === "Created" && approvers.length === ids.length && approvers.every((a) => a.exists) && members.every((m) => m.exists && permissionAllows(normalizedPermissions(m.data().permissions), "orders", "approve"))
            && users.every((u) => !u.disabled && u.emailVerified && u.email);
          if (permitted) data.payload = { ...data.payload, to: [...new Set(users.map((u) => u.email))] };
        }
      } catch { permitted = false; }
    }
    if (!["hotel-invitation", "order-approval", "order-confirmation"].includes(data.type)) permitted = false;
    if (data.type === "order-confirmation") {
      const { requireDocumentId } = require("./subscriptions");
      try {
        requireDocumentId(data.orderId, "Order ID"); requireDocumentId(data.dispatchRequestId, "Dispatch ID");
        const dispatch = await tx.get(db.doc(`hotels/${hotelUid}/dispatches/${data.dispatchRequestId}`));
        const order = await tx.get(db.doc(`hotels/${hotelUid}/orders/${data.orderId}`));
        permitted = permitted && dispatch.exists && dispatch.data().orderId === data.orderId
          && ["processing", "queued"].includes(dispatch.data().status) && order.data()?.dispatchRequestId === data.dispatchRequestId;
        if (permitted) {
          const { permissionAllows, normalizedPermissions } = require("./authorization");
          const member = await tx.get(db.doc(`hotels/${hotelUid}/members/${dispatch.data().actorUid}`));
          const approver = await tx.get(db.doc(`hotels/${hotelUid}/outlets/${dispatch.data().order.outletId}/approvers/${dispatch.data().actorUid}`));
          permitted = await dispatchActorIsCurrent(dispatch.data().actorUid, services.auth || admin.auth())
            && member.exists && approver.exists && permissionAllows(normalizedPermissions(member.data().permissions), "orders", "approve");
        }
      } catch { permitted = false; }
    }
    if (!permitted || !subscription.exists || !subscriptionIsActive(subscription.data())) {
      tx.update(ref, { status: "blocked", error: "Hotel subscription or delivery authorization is no longer valid." });
      return { ...data, blocked: true };
    }
    tx.update(ref, { status: "processing", processingAt: admin.firestore.FieldValue.serverTimestamp() });
    if (data.type === "order-confirmation") {
      tx.update(db.doc(`hotels/${hotelUid}/dispatches/${data.dispatchRequestId}`), {
        status: "processing", processingAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    return data;
  });
  if (!mail) return;
  const finishOrder = (status, detail) => mail.type === "order-confirmation" && mail.orderId && mail.dispatchRequestId
    ? completeDispatch(db, hotelUid, mail.orderId, mail.dispatchRequestId, status, detail) : Promise.resolve();
  if (mail.blocked) {
    await finishOrder("blocked", { error: "Hotel subscription is inactive." });
    return;
  }
  let externalAttempt = false;
  try {
    const from = services.from || String(RESEND_FROM.value() || "").trim();
    const apiKey = services.send ? "test-transport" : String(RESEND_API_KEY.value() || "").trim();
    if (!from || !apiKey) throw new Error("Email configuration is incomplete.");
    const payload = mail.payload || {};
    const to = sanitizeEmails(payload.to);
    if (!to.length || to.length > 20) throw new Error("Invalid email recipients.");
    const send = services.send || ((data, options) => new Resend(apiKey).emails.send(data, options));
    externalAttempt = true;
    const { acknowledgedSend } = require("./scheduledMailDelivery");
    const response = await acknowledgedSend(send, { ...payload, from, to }, { idempotencyKey: `hotelsuite/${digest(hotelUid, mailId)}` });
    await db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      if (current.data()?.status !== "processing") return;
      tx.update(ref, { status: "sent", sentAt: admin.firestore.FieldValue.serverTimestamp(), provider: "resend", providerId: response.data.id });
    });
    await finishOrder("sent", { via: "email", providerId: response.data.id });
    logger.info("Email delivery accepted", { hotelUid, mailId });
  } catch {
    const status = externalAttempt ? "needs-review" : "failed";
    const error = externalAttempt ? "Email delivery is unconfirmed. Check the provider before any recovery." : "Review email configuration before recovery.";
    await ref.update({ status, error, failedAt: admin.firestore.FieldValue.serverTimestamp() });
    await finishOrder(status, { error, externalAttempt });
    logger.error("Email delivery requires review", { hotelUid, mailId, externalAttempt });
  }
}

const processMailQueue = onDocumentCreated({ document: "hotels/{hotelUid}/mailQueue/{mailId}", secrets: [RESEND_API_KEY, RESEND_FROM] }, processMailQueueHandler);

module.exports = { buildOrderSftpCsv, buildOrderExportBaseFilename, buildOrderEmailPayload, processMailQueue,
  processMailQueueHandler, enqueueOrderEmail };

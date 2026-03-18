const { onDocumentCreated, logger, admin, Resend, ExcelJS, PDFDocument, RESEND_API_KEY, RESEND_FROM } = require("./config");

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

const processMailQueue = onDocumentCreated(
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

module.exports = {
  buildOrderSftpCsv,
  buildOrderExportBaseFilename,
  processMailQueue,
  enqueueOrderEmail,
};

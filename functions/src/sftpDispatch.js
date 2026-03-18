const { onDocumentWritten, logger, admin, SftpClient, RESEND_API_KEY, RESEND_FROM } = require("./config");
const { enqueueOrderEmail } = require("./mailQueue");

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

const sendOrderedSupplierOrder = onDocumentWritten(
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

module.exports = { sendOrderedSupplierOrder };

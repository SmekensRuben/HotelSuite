const { onDocumentCreated, logger, admin, Resend, React, RESEND_API_KEY, RESEND_FROM } = require("./config");

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

const sendOrderApprovalEmailToApprovers = onDocumentCreated(
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

module.exports = { sendOrderApprovalEmailToApprovers };

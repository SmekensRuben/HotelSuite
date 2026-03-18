const { onDocumentCreated, onSchedule, logger, admin, Resend, React, RESEND_API_KEY, RESEND_FROM } = require("./config");

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

const sendContractCancellationReminders = onSchedule(
  {
    schedule: "0 6 * * *",
    timeZone: "Europe/Brussels",
    secrets: [RESEND_API_KEY, RESEND_FROM],
  },
  async () => {
    await processContractCancellationReminders();
  }
);

const runContractCancellationRemindersNow = onDocumentCreated(
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

module.exports = {
  sendContractCancellationReminders,
  runContractCancellationRemindersNow,
};

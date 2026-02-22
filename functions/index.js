const functions = require("firebase-functions");
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: "breakfastpilotapp@gmail.com",
    pass: "jjtg pkdb fdpd ebix"
  }
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

exports.sendTestMail = functions.https.onRequest(async (req, res) => {
  // Zet altijd CORS headers (ook bij error/return!)
  Object.entries(corsHeaders).forEach(([k, v]) => res.set(k, v));

  if (req.method === "OPTIONS") {
    res.status(204).send(""); // Preflight response
    return;
  }

  const { to, subject, text } = req.body;
  if (!to || !subject || !text) {
    res.status(400).json({ error: "Missing fields" });
    return;
  }
  try {
    await transporter.sendMail({
      from: "breakfastpilotapp@gmail.com",
      to,
      subject,
      text,
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function getMeiliConfig() {
  const host = functions.config().meili?.host || process.env.MEILI_HOST;
  const apiKey = functions.config().meili?.key || process.env.MEILI_API_KEY;
  const indexUid = functions.config().meili?.index || process.env.MEILI_INDEX || "catalogproducts";

  if (!host || !apiKey) {
    throw new Error("Missing Meilisearch config. Set meili.host and meili.key (or MEILI_HOST/MEILI_API_KEY).");
  }

  return {
    host: host.replace(/\/$/, ""),
    apiKey,
    indexUid,
  };
}

async function meiliRequest(path, { method = "GET", body } = {}) {
  const { host, apiKey } = getMeiliConfig();
  const response = await fetch(`${host}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Meili request failed (${response.status}): ${text}`);
  }

  return response;
}

async function ensureIndex(indexUid) {
  const response = await meiliRequest("/indexes", {
    method: "POST",
    body: { uid: indexUid, primaryKey: "id" },
  });

  if (response.status === 202 || response.status === 201) {
    return;
  }
}

exports.syncCatalogProductsToMeili = functions.firestore
  .document("hotels/{hotelUid}/catalogproducts/{productId}")
  .onWrite(async (change, context) => {
    const { hotelUid, productId } = context.params;
    const { indexUid } = getMeiliConfig();

    await ensureIndex(indexUid);

    if (!change.after.exists) {
      await meiliRequest(`/indexes/${indexUid}/documents/${productId}`, {
        method: "DELETE",
      });
      return;
    }

    const productData = change.after.data() || {};
    const document = {
      id: productId,
      hotelUid,
      ...productData,
    };

    await meiliRequest(`/indexes/${indexUid}/documents`, {
      method: "POST",
      body: [document],
    });
  });

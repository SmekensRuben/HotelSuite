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
  Object.entries(corsHeaders).forEach(([k, v]) => res.set(k, v));

  if (req.method === "OPTIONS") {
    res.status(204).send("");
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
  const indexUid =
    functions.config().meili?.index || process.env.MEILI_INDEX || "catalogproducts";

  if (!host || !apiKey) {
    throw new Error(
      "Missing Meilisearch config. Set meili.host and meili.key (or MEILI_HOST/MEILI_API_KEY)."
    );
  }

  return {
    host: host.replace(/\/$/, ""),
    apiKey,
    indexUid,
  };
}

async function meiliRequest(path, { method = "GET", body } = {}) {
  const { host, apiKey } = getMeiliConfig();

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

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = text;
  }

  if (!res.ok) {
    const msg = typeof data === "string" ? data : JSON.stringify(data ?? {});
    const err = new Error(`Meili request failed (${res.status}): ${msg}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }

  return data;
}

let ensuredIndexUids = new Set();

async function ensureIndex(indexUid) {
  if (ensuredIndexUids.has(indexUid)) return;

  const checkRes = await meiliRequest(`/indexes/${encodeURIComponent(indexUid)}`, {
    method: "GET",
  });

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

  if (![201, 202, 409].includes(createRes.status)) {
    const text = await createRes.text();
    throw new Error(`Index create failed (${createRes.status}): ${text}`);
  }

  ensuredIndexUids.add(indexUid);
}

exports.syncCatalogProductsToMeili = functions.firestore
  .document("hotels/{hotelUid}/catalogproducts/{productId}")
  .onWrite(async (change, context) => {
    const { hotelUid, productId } = context.params;
    const { indexUid } = getMeiliConfig();

    await ensureIndex(indexUid);

    if (!change.after.exists) {
      const res = await meiliRequest(
        `/indexes/${encodeURIComponent(indexUid)}/documents/${encodeURIComponent(productId)}`,
        { method: "DELETE" }
      );

      if (![200, 202, 404].includes(res.status)) {
        const text = await res.text();
        throw new Error(`Delete failed (${res.status}): ${text}`);
      }

      return;
    }

    const productData = change.after.data() || {};
    const document = {
      id: productId,
      hotelUid,
      name: productData.name ?? "",
      brand: productData.brand ?? "",
    };

    const result = await meiliJson(
      `/indexes/${encodeURIComponent(indexUid)}/documents`,
      {
        method: "POST",
        body: [document],
      }
    );

    if (result?.taskUid !== undefined) {
      functions.logger.info("Meili upsert enqueued", {
        indexUid,
        productId,
        taskUid: result.taskUid,
      });
    }
  });

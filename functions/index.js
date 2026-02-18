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

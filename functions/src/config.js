const firestoreTriggers = require("firebase-functions/v2/firestore");
const httpsTriggers = require("firebase-functions/v2/https");
const storageTriggers = require("firebase-functions/v2/storage");
const schedulerTriggers = require("firebase-functions/v2/scheduler");
const { secretBindings, guardScheduledHandler, externalActionsAllowed } = require("./environmentPolicy");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, FieldPath, Timestamp } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { getStorage } = require("firebase-admin/storage");
// Keep the existing module interface while using the modular Admin SDK v14 API.
const admin = {
  firestore: Object.assign(getFirestore, { FieldValue, FieldPath, Timestamp }),
  auth: getAuth,
  storage: getStorage,
};
const { Resend } = require("resend");
const SftpClient = require("ssh2-sftp-client");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const React = require("react");

function isolatedOptions(options) {
  return options && typeof options === "object" && options.secrets
    ? { ...options, secrets: secretBindings(options.secrets) } : options;
}
const onDocumentCreated = (options, handler) => firestoreTriggers.onDocumentCreated(isolatedOptions(options), handler);
const onDocumentWritten = (options, handler) => firestoreTriggers.onDocumentWritten(isolatedOptions(options), handler);
const onRequest = (options, handler) => httpsTriggers.onRequest(isolatedOptions(options), handler);
const onObjectFinalized = (options, handler) => storageTriggers.onObjectFinalized(isolatedOptions(options), handler);
const onSchedule = (options, handler) => schedulerTriggers.onSchedule(isolatedOptions(options), guardScheduledHandler(handler));

if (!getApps().length) {
  initializeApp();
}

// Unbound defineSecret declarations still make the CLI resolve Secret Manager
// parameters. Do not declare provider secrets at all for isolated deployments.
const providerSecret = (name) => externalActionsAllowed() ? defineSecret(name) : { name, value: () => "" };
const MEILI_HOST = providerSecret("MEILI_HOST");
const MEILI_INDEX = providerSecret("MEILI_INDEX");
const MEILI_API_KEY = providerSecret("MEILI_API_KEY");
const SUPPLIER_PRODUCTS_INDEX_UID = "supplierproducts";
const RESEND_API_KEY = providerSecret("RESEND_API_KEY");
const RESEND_FROM = providerSecret("RESEND_FROM");
const RESEND_WEBHOOK_SECRET = providerSecret("RESEND_WEBHOOK_SECRET");
const OPENAI_API_KEY = providerSecret("OPENAI_API_KEY");
const APP_BASE_URL = defineString("APP_BASE_URL");

function getAppBaseUrl() {
  const value = String(APP_BASE_URL.value() || "").trim().replace(/\/$/, "");
  if (!/^https:\/\//.test(value)) throw new Error("APP_BASE_URL must be an explicit HTTPS URL");
  return value;
}

module.exports = {
  onDocumentCreated,
  onDocumentWritten,
  onRequest,
  onObjectFinalized,
  onSchedule,
  logger,
  admin,
  Resend,
  SftpClient,
  ExcelJS,
  PDFDocument,
  React,
  MEILI_HOST,
  MEILI_INDEX,
  MEILI_API_KEY,
  SUPPLIER_PRODUCTS_INDEX_UID,
  RESEND_API_KEY,
  RESEND_FROM,
  RESEND_WEBHOOK_SECRET,
  OPENAI_API_KEY,
  APP_BASE_URL,
  getAppBaseUrl,
};

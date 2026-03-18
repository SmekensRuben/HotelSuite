const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { onObjectFinalized } = require("firebase-functions/v2/storage");
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

const MEILI_HOST = defineSecret("MEILI_HOST");
const MEILI_INDEX = defineSecret("MEILI_INDEX");
const MEILI_API_KEY = defineSecret("MEILI_API_KEY");
const SUPPLIER_PRODUCTS_INDEX_UID = "supplierproducts";
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");
const RESEND_FROM = defineSecret("RESEND_FROM");

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
};

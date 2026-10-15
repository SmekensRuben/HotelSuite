// Workbook audit columns describe the source; only protected commands author new audit data.
export const SUPPLIER_PRODUCT_FIELDS = ["documentId", "revision", "supplierId", "supplierSku", "supplierProductName", "brand", "gtin", "currency", "pricingModel", "priceBasis", "vatRate", "priceValidFrom", "priceValidUntil", "pricePerBaseUnit", "pricePerPurchaseUnit", "purchaseUnit", "baseUnit", "baseUnitsPerPurchaseUnit", "purchaseOptions", "catalogProductId", "active", "hasVariants", "variants"];
export const SUPPLIER_PRODUCT_AUDIT_FIELDS = ["supplierName", "createdAt", "createdBy", "updatedAt", "updatedBy", "priceUpdatedOn", "managedImageAssetId", "managedImageStatus", "managedImagePolicyVersion", "imageRevision"];
export const SUPPLIER_PRODUCT_EXPORT_HEADERS = [...SUPPLIER_PRODUCT_FIELDS, ...SUPPLIER_PRODUCT_AUDIT_FIELDS];
export const SUPPLIER_PRODUCT_TEMPLATE_HEADERS = SUPPLIER_PRODUCT_FIELDS.filter((field) => !["documentId", "revision", "hasVariants", "variants"].includes(field));
export const SUPPLIER_PRODUCT_TEMPLATE_ROW = { supplierId: "", supplierSku: "", supplierProductName: "", brand: "", gtin: "", currency: "", pricingModel: "Per Purchase Unit", priceBasis: "unknown", vatRate: "", priceValidFrom: "", priceValidUntil: "", pricePerBaseUnit: "", pricePerPurchaseUnit: "", purchaseUnit: "", baseUnit: "", baseUnitsPerPurchaseUnit: "", purchaseOptions: "[]", catalogProductId: "", active: "true" };

function auditDate(value) {
  if (value == null || value === "") return "";
  const date = typeof value?.toDate === "function" ? value.toDate() : value instanceof Date ? value : typeof value?.seconds === "number" ? new Date(value.seconds * 1000) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : typeof value === "string" ? value : "";
}

export function supplierProductExportRow(product) {
  const revision = product.revision === undefined ? 0 : product.revision;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new Error("A product has an invalid revision. Review it before exporting an editable workbook.");
  if (product.purchaseOptions != null && !Array.isArray(product.purchaseOptions)) throw new Error("A product's purchase options need review before export.");
  return {
    documentId: product.id || product.documentId || "", revision,
    supplierId: product.supplierId || "", supplierSku: product.supplierSku || "", supplierProductName: product.supplierProductName || "", brand: product.brand || "", gtin: product.gtin || "",
    currency: product.currency || "", pricingModel: product.pricingModel || "", priceBasis: product.priceBasis || "unknown", vatRate: product.vatRate ?? "",
    priceValidFrom: product.priceValidFrom || "", priceValidUntil: product.priceValidUntil || "", pricePerBaseUnit: product.pricePerBaseUnit ?? "", pricePerPurchaseUnit: product.pricePerPurchaseUnit ?? "",
    purchaseUnit: product.purchaseUnit || "", baseUnit: product.baseUnit || "", baseUnitsPerPurchaseUnit: product.baseUnitsPerPurchaseUnit ?? "", purchaseOptions: JSON.stringify(product.purchaseOptions || []),
    catalogProductId: product.catalogProductId || "", active: product.active !== false ? "true" : "false", hasVariants: product.hasVariants === true ? "true" : "false", variants: JSON.stringify(product.variants || []),
    supplierName: product.supplierName || "", createdAt: auditDate(product.createdAt), createdBy: product.createdBy || "", updatedAt: auditDate(product.updatedAt), updatedBy: product.updatedBy || "", priceUpdatedOn: auditDate(product.priceUpdatedOn),
    managedImageAssetId: product.image?.assetId || "", managedImageStatus: product.image?.status || "", managedImagePolicyVersion: product.image?.policyVersion ?? "", imageRevision: product.imageRevision ?? "",
  };
}

const clean = (value) => String(value ?? "").trim();
function number(value, field) {
  if (clean(value) === "") return undefined;
  const parsed = Number(clean(value).replace(",", "."));
  if (!Number.isFinite(parsed)) throw new Error(`${field} must contain a finite number or be blank.`);
  return parsed;
}
function boolean(value, field, fallback) {
  const parsed = clean(value).toLowerCase();
  if (!parsed) return fallback;
  if (parsed === "true") return true;
  if (parsed === "false") return false;
  throw new Error(`${field} must contain true or false.`);
}
function array(value, field) {
  if (!clean(value)) return [];
  let parsed;
  try { parsed = JSON.parse(clean(value)); } catch { throw new Error(`${field} must contain a valid JSON array.`); }
  if (!Array.isArray(parsed)) throw new Error(`${field} must contain a JSON array.`);
  return parsed;
}

export function parseSupplierProductRows(rows) {
  if (!Array.isArray(rows)) throw new Error("The supplier-product worksheet is invalid.");
  const products = [], identities = new Set();
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Row ${index + 2}: invalid worksheet row.`);
    if (!Object.values(row).some((value) => clean(value) !== "")) return;
    try {
      if (clean(row.imageUrl)) throw new Error("External image URLs are not supported. Upload image files through the product image workflow.");
      if (!clean(row.supplierId) || !clean(row.supplierSku) || !clean(row.supplierProductName)) throw new Error("Supplier, SKU and product name are required; incomplete rows are never skipped.");
      const revision = number(row.revision, "revision");
      if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)) throw new Error("revision must be a non-negative whole number within the supported range.");
      const documentId = clean(row.documentId) || undefined;
      const identity = documentId ? `id:${documentId}` : `offer:${clean(row.supplierId)}:${clean(row.supplierSku)}`;
      if (identities.has(identity)) throw new Error("The workbook contains a duplicate product identity.");
      identities.add(identity);
      const purchaseOptions = array(row.purchaseOptions, "purchaseOptions");
      if (purchaseOptions.some((option) => !option || typeof option !== "object" || Array.isArray(option) || !clean(option.id))) throw new Error("Each purchase option needs its own stable ID.");
      const optionIds = purchaseOptions.map((option) => clean(option.id));
      if (optionIds.includes("default") || new Set(optionIds).size !== optionIds.length) throw new Error("Additional purchase-option IDs must be unique and cannot be default.");
      const variants = array(row.variants, "variants");
      const hasVariants = boolean(row.hasVariants, "hasVariants", false);
      if (hasVariants || variants.length) throw new Error("Legacy variants require manual review and explicit purchaseOptions before import.");
      products.push({
        documentId, revision, supplierId: clean(row.supplierId), supplierSku: clean(row.supplierSku), supplierProductName: clean(row.supplierProductName),
        ...(clean(row.brand) ? { brand: clean(row.brand) } : {}),
        ...(Object.hasOwn(row, "gtin") ? { gtin: clean(row.gtin) || null } : {}),
        currency: clean(row.currency).toUpperCase(), pricingModel: clean(row.pricingModel), priceBasis: clean(row.priceBasis) || "unknown", vatRate: number(row.vatRate, "vatRate") ?? null,
        ...(Object.hasOwn(row, "priceValidFrom") ? { priceValidFrom: clean(row.priceValidFrom) || null } : {}),
        ...(Object.hasOwn(row, "priceValidUntil") ? { priceValidUntil: clean(row.priceValidUntil) || null } : {}),
        pricePerBaseUnit: number(row.pricePerBaseUnit, "pricePerBaseUnit") ?? null, pricePerPurchaseUnit: number(row.pricePerPurchaseUnit, "pricePerPurchaseUnit") ?? null,
        purchaseUnit: clean(row.purchaseUnit), baseUnit: clean(row.baseUnit), baseUnitsPerPurchaseUnit: number(row.baseUnitsPerPurchaseUnit, "baseUnitsPerPurchaseUnit"), purchaseOptions,
        catalogProductId: clean(row.catalogProductId), active: boolean(row.active, "active", true), hasVariants: false, variants: [],
      });
    } catch (error) { throw new Error(`Row ${index + 2}: ${error.message}`); }
  });
  if (!products.length) throw new Error("The worksheet contains no supplier products to import.");
  return products;
}

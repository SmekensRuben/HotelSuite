import { formatInventoryQuantity } from "../inventory/inventoryFormatting";
import { PRODUCT_UNIT_LABELS } from "../../utils/productUnitDisplay";

/** Historical displays use recorded conversion terms, never a current catalog lookup. */
export function frozenStockContent(line) {
  const terms = line?.inventoryTerms;
  if (terms?.inventoryPolicyVersion !== 1 || terms.available !== true || !Object.hasOwn(PRODUCT_UNIT_LABELS, terms.catalogBaseUnit)
    || typeof terms.catalogUnitsPerPurchaseUnit !== "number" || !Number.isFinite(terms.catalogUnitsPerPurchaseUnit)
    || terms.catalogUnitsPerPurchaseUnit <= 0) return "Catalog stock conversion unavailable";
  return `${formatInventoryQuantity(terms.catalogUnitsPerPurchaseUnit)} ${terms.catalogBaseUnit} per ${line.purchaseUnit || "purchase unit"} in stock counts`;
}

export function formatArticlePackaging(article) {
  if (!article) return "";
  const units = formatNumericValue(article.unitsPerPurchaseUnit);
  const content = formatNumericValue(article.contentPerStockUnit);
  const recipeUnit = (article.recipeUnit || "").trim();
  const purchaseUnit = (article.purchaseUnit || "").trim();

  const hasUnits = units !== "";
  const hasContent = content !== "";

  if (!hasUnits && !hasContent) return "";

  if (hasUnits && hasContent) {
    const contentLabel = recipeUnit ? `${content} ${recipeUnit}` : content;
    const perPurchase = purchaseUnit ? `/${purchaseUnit}` : "";
    return `${units} x ${contentLabel}${perPurchase}`.trim();
  }

  if (hasUnits) {
    return `${units}${purchaseUnit ? ` ${purchaseUnit}` : ""}`.trim();
  }

  const contentLabel = recipeUnit ? `${content} ${recipeUnit}` : content;
  return `${contentLabel}${purchaseUnit ? `/${purchaseUnit}` : ""}`.trim();
}

function formatNumericValue(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  const num = Number(value);
  if (Number.isFinite(num)) {
    if (Number.isInteger(num)) {
      return String(num);
    }
    const trimmed = String(num).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
    return trimmed;
  }
  return String(value);
}

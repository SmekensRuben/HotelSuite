export function parseLocalizedNumber(value) {
  if (typeof value === "number") {
    return value;
  }
  const str = String(value).trim();
  if (str === "") {
    return NaN;
  }
  if (str.includes(",")) {
    return Number(str.replace(/\./g, "").replace(",", "."));
  }
  return Number(str);
}

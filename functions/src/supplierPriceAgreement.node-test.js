const assert = require("node:assert/strict");
const test = require("node:test");
const { validateSupplier, supplierPublicView } = require("./suppliers");
const supplier = { name: "Supplier", orderSystem: "Email", orderEmailCc: [], deliveryDays: [1, 3] };
test("supplier price agreements are explicit, valid and exposed without credentials", () => {
  for (const basis of ["order-date", "delivery-date"]) {
    const value = validateSupplier({ ...supplier, priceDateBasis: basis });
    assert.equal(value.priceDateBasis, basis);
    const view = supplierPublicView("supplier-a", { ...value, password: "fictional", sftpPassword: "fictional" });
    assert.equal(view.priceDateBasis, basis);
    assert.equal(view.password, undefined);
    assert.equal(view.sftpPassword, undefined);
  }
  assert.throws(() => validateSupplier({ ...supplier, priceDateBasis: "" }), /Choose whether/);
  assert.throws(() => validateSupplier({ ...supplier, priceDateBasis: "invoice-date" }), /Choose whether/);
});
test("old supplier edits preserve an existing agreement rather than inventing a new one", () => {
  assert.equal(Object.hasOwn(validateSupplier(supplier), "priceDateBasis"), false);
  assert.equal(Object.hasOwn(supplierPublicView("supplier-a", supplier), "priceDateBasis"), false);
});

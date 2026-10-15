import { expect, it } from "vitest";
import { purchaseRequestReturnPath } from "./purchaseRequestLink";

it("retains local request email context without accepting external or unrelated login redirects", () => {
  const path = "/purchase-requests/request-one?hotel=hotel-b#timeline";
  expect(purchaseRequestReturnPath(path)).toBe(path);
  for (const invalid of [null, "https://example.test", "//example.test", "/\\example.test", "/platform", "/purchase-requests-elsewhere", "/purchase-requests/id\n"]) {
    expect(purchaseRequestReturnPath(invalid)).toBeNull();
  }
});

import { describe, expect, it } from "vitest";
import { normalizeDocumentId } from "./productIdUtils";

describe("normalizeDocumentId", () => {
  it("vervangt spaties en speciale tekens door underscores", () => {
    expect(normalizeDocumentId("  SKU 12/34 (test)  ")).toBe("SKU_12_34_test");
  });

  it("normaliseert meerdere opeenvolgende underscores en trimt randen", () => {
    expect(normalizeDocumentId("@@ab   cd##")).toBe("ab_cd");
  });

  it("retourneert lege string als er geen geldige tekens zijn", () => {
    expect(normalizeDocumentId("   !!!   ")).toBe("");
  });
});

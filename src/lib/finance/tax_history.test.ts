import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isMissing, normalizeTaxHistory } from "./tax_history";

describe("tax history normalization", () => {
  test("keeps zero distinct from missing values", () => {
    const [year] = normalizeTaxHistory({
      years: [{ year: "2024-25", tax: 0, refund: null, income_heads: { salary: "0" } }]
    });
    assert.equal(year.tax, 0);
    assert.equal(year.refund, null);
    assert.equal(year.income_heads?.salary, 0);
    assert.equal(isMissing(year.tax), false);
    assert.equal(isMissing(year.refund), true);
  });

  test("accepts history envelope and source-level gains", () => {
    const [year] = normalizeTaxHistory({
      history: [{ year: "2023-24", capital_gains: [{ source: "Broker", total: "1,250" }] }]
    });
    assert.equal(year.capital_gains?.[0].total, 1250);
  });
});

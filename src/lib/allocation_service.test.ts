import assert from "node:assert/strict";
import test from "node:test";
import { calculateAllocation, validateAllocationTargets } from "./allocation_service";

test("validates target percentages and reports the total", () => {
  assert.equal(validateAllocationTargets([{ assetClass: "Equity", target: 60 }, { assetClass: "Debt", target: 40 }]).valid, true);
  const invalid = validateAllocationTargets({ Equity: 60, Debt: 30 });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.total, 90);
  assert.match(invalid.errors[0], /sum to 100/);
});

test("maps holdings, calculates drift, and computes amount to target", () => {
  const result = calculateAllocation({
    holdings: [
      { id: "stock", holdingType: "stock", security: "ABC", value: 600 },
      { id: "bond", holdingType: "bond", security: "Bond fund", value: "300" },
      { id: "cash", holdingType: "cash", value: 100 }
    ],
    mappings: [
      { security: "ABC", assetClass: "Indian equity" },
      { holdingType: "bond", assetClass: "Debt" },
      { holdingType: "cash", assetClass: "Cash" }
    ],
    targets: [
      { assetClass: "Indian equity", target: 50 },
      { assetClass: "Debt", target: 30 },
      { assetClass: "Cash", target: 20 }
    ]
  });
  assert.equal(result.unclassifiedHoldings.length, 0);
  assert.equal(result.totalValue, 1000);
  assert.deepEqual(result.allocations.map((row) => [row.assetClass, row.currentPercentage, row.driftPercentagePoints, row.amountToTarget]), [
    ["Indian equity", 60, 10, -100], ["Debt", 30, 0, 0], ["Cash", 10, -10, 100]
  ]);
});

test("surfaces unclassified holdings while retaining them in the portfolio denominator", () => {
  const result = calculateAllocation({
    holdings: [{ id: "known", holdingType: "stock", value: 75 }, { id: "unknown", holdingType: "other", security: "Mystery", value: 25 }],
    mappings: [{ holdingType: "stock", assetClass: "Equity" }],
    targets: [{ assetClass: "Equity", target: 100 }]
  });
  assert.equal(result.unclassifiedValue, 25);
  assert.equal(result.classifiedValue, 75);
  assert.equal(result.unclassifiedHoldings[0].id, "unknown");
  assert.equal(result.allocations[0].currentPercentage, 75);
  assert.equal(result.allocations[0].amountToTarget, 25);
});

test("rejects malformed holding values", () => {
  assert.throws(() => calculateAllocation({ holdings: [{ holdingType: "stock", value: "not-a-number" }], mappings: [] }), /Holding value/);
});

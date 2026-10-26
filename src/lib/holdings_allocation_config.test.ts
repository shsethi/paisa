import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultAllocationConfig,
  HOLDINGS_ALLOCATION_STORAGE_KEY,
  loadAllocationConfig,
  parseAllocationConfig,
  saveAllocationConfig
} from "./holdings_allocation_config";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  };
}

test("seeds one editable mapping per distinct source category", () => {
  assert.deepEqual(defaultAllocationConfig(["Debt", " Equity ", "Debt", ""]), {
    mappings: [
      { holdingType: "Debt", assetClass: "Debt" },
      { holdingType: "Equity", assetClass: "Equity" }
    ],
    targets: []
  });
});

test("round-trips config through the browser storage key", () => {
  const storage = memoryStorage();
  const config = {
    mappings: [{ holdingType: "Debt", assetClass: "Fixed income" }],
    targets: [{ assetClass: "Fixed income", target: 40 }]
  };
  assert.equal(saveAllocationConfig(storage, config), true);
  assert.equal(storage.getItem(HOLDINGS_ALLOCATION_STORAGE_KEY) !== null, true);
  assert.deepEqual(loadAllocationConfig(storage), config);
});

test("drops malformed entries from persisted config", () => {
  const parsed = parseAllocationConfig({
    mappings: [
      { holdingType: "Debt", assetClass: "Debt" },
      { holdingType: "", assetClass: "" },
      "bad"
    ],
    targets: [
      { assetClass: "Debt", target: "40" },
      { assetClass: "Equity", target: "not-a-number" },
      { assetClass: "Cash", target: null }
    ]
  });
  assert.deepEqual(parsed, {
    mappings: [{ holdingType: "Debt", assetClass: "Debt" }],
    targets: [{ assetClass: "Debt", target: 40 }]
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseManualInvestmentTrades } from "./manual_investment_trades";

test("imports settled manual investment lots and excludes pending lots", () => {
  const csv =
    "trade_date,instrument,isin,side,quantity,price,currency,status,type\n2026-03-04,MEESHO,INE0VDM01015,buy,13740,155.51,INR,settled,IPO\n2026-09-16,MEESHO,INE0VDM01015,buy,5439,212.83,INR,pending,IPO\n";
  const result = parseManualInvestmentTrades(csv);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].quantity, "13740");
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.errors, []);
});

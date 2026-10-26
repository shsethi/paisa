import assert from "node:assert/strict";
import { test } from "node:test";
import { parseKuveraTransactionsCSV } from "./kuvera_transactions_import";

const header = "Date,Folio Number,Name of the Fund,Order,Units,NAV,Current Nav,Amount (INR)";

test("parses Kuvera buy and sell transactions with their cost-basis fields", () => {
  const parsed = parseKuveraTransactionsCSV(`${header}\n2026-10-05,9109449625,Navi Nifty 50 Index Growth Direct Plan,buy,670.851,14.9057,14.9391,9999.5\n2026-10-10,9109449625,Navi Nifty 50 Index Growth Direct Plan,sell,10,15,15.2,152\n`);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows.map((row) => [row.trade_date, row.side, row.quantity, row.price]), [["2026-10-05", "buy", "670.851", "14.9057"], ["2026-10-10", "sell", "10", "15"]]);
});

test("rejects invalid Kuvera transaction rows without fabricating a trade", () => {
  const parsed = parseKuveraTransactionsCSV(`${header}\n2026-10-05,9109449625,Navi Fund,hold,0,14.9,15,0\n`);
  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.errors[0].code, "invalid_transaction_row");
  assert.equal(parsed.errors[0].record_locator, "csv row 2");
});

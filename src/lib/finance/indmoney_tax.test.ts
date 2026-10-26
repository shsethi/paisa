import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parseIndmoneyTax } from "./indmoney_tax";

test("parses capital-gain and dividend summaries with sheet/row provenance", () => {
  const wb = XLSX.utils.book_new();
  const ltcg = XLSX.utils.aoa_to_sheet([["Client Name:", "Test"], ["Financial Year:", "2025-26"], [], ["Long Term Capital Gains Summary"], ["Asset Category", "Sell", "Buy", "Expense", "Loss", "Taxable"], ["Non-Equity (Others)", 100, 40, 2, 0, 58], ["Total", 100, 40, 2, 0, 58]]);
  const dividend = XLSX.utils.aoa_to_sheet([["Financial Year:", "2025-26"], ["Dividend Summary"], ["Particulars", "Amount"], ["US Stocks", 12.5]]);
  XLSX.utils.book_append_sheet(wb, ltcg, "LTCG"); XLSX.utils.book_append_sheet(wb, dividend, "Dividend");
  const result = parseIndmoneyTax(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records[0].amounts, { sell_value: "100.00", buy_value: "40.00", expense: "2.00", disallowed_loss: "0.00", taxable_gain: "58.00" });
  assert.equal(result.records[0].source.sheet_name, "LTCG"); assert.equal(result.records[0].source.source_row, 6);
  assert.equal(result.records[1].summary_type, "dividend");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseManualBalancesCSV } from "./manual_balances";
import { importManualBalancesFile } from "./manual_balances_import";

const fixture = `,,,,
REAL ASSETS,,,
Particulars,Details,Current Market Value
Property,Home,"₹1,00,000"
,Home 2,
CASH FLOW,,,
Monthly component,,Yearly component
Rent,"₹12,000",,Insurance,"₹4,000"
MONTHLY SURPLUS AVAILABLE FOR FRESH INVESTMENTS,,,
Income,"₹50,000"
LIABILITIES,,,
Particulars,Amount Outstanding
Loan,"₹2,00,000"
FINANCIAL ASSETS,,,,,,
Particulars,Owner,Amount Invested,Current Value,Return,Contribution,Type
Fund,Owner,"₹1,000","₹1,200",,,Debt
`;

test("parses dated manual snapshot sections and retains unknown amounts", () => {
  const result = parseManualBalancesCSV(fixture, "manual/assets-liabilities/Jan [2026] snapshot.csv");
  assert.equal(result.asOfDate, "2026-01-01");
  assert.equal(result.errors.length, 0);
  assert.ok(result.rows.some((row) => row.balance_type === "asset" && row.label === "Home" && row.amount === "100000"));
  assert.ok(result.rows.some((row) => row.balance_type === "asset" && row.label === "Home 2" && row.amount === null));
  assert.ok(result.rows.some((row) => row.balance_type === "liability" && row.amount === "200000"));
  assert.ok(result.rows.some((row) => row.balance_type === "cash_flow" && row.label === "Income"));
});

test("imports atomically and is idempotent", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paisa-manual-"));
  mkdirSync(path.join(root, "imports", "manual", "assets-liabilities"), { recursive: true });
  writeFileSync(path.join(root, "imports", "manual", "assets-liabilities", "Jan [2026] snapshot.csv"), fixture);
  const options = { root, file: "manual/assets-liabilities/Jan [2026] snapshot.csv", now: new Date("2026-01-02T00:00:00Z") };
  const first = importManualBalancesFile(options);
  const second = importManualBalancesFile(options);
  assert.equal(first.status, "succeeded");
  assert.equal(second.already_imported, true);
  assert.equal(first.row_counts.accepted, second.row_counts.accepted);
});

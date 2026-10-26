import assert from "node:assert/strict";
import test from "node:test";
import { buildFinanceReconciliation } from "./finance_reconciliation";

test("checks a bank balance chain in either statement direction", () => {
  const report = buildFinanceReconciliation({
    bankStatements: [
      {
        source: "statement.xls",
        transactions: [
          { debit: null, credit: "100.00", balance: "1100.00", currency: "INR" },
          { debit: "40.00", credit: null, balance: "1060.00", currency: "INR" }
        ]
      }
    ],
    holdings: [],
    balances: [],
    taxRecords: [],
    generatedAt: new Date("2026-10-25T00:00:00Z")
  });
  assert.equal(report.bank_balances[0].status, "ok");
  assert.equal(report.bank_balances[0].opening_balance, "1000.00");
  assert.equal(report.bank_balances[0].closing_balance, "1060.00");
});

test("reports duplicate holdings, currency totals, and incomplete tax years", () => {
  const report = buildFinanceReconciliation({
    bankStatements: [],
    holdings: [
      {
        current_value: "100",
        currency: "INR",
        security: { identifier: "INF123" },
        source: { original_path: "a.csv" }
      },
      {
        current_value: "50",
        currency: "INR",
        security: { identifier: "INF123" },
        source: { original_path: "b.pdf" }
      }
    ],
    balances: [
      { amount: "25", currency: "INR", balance_type: "asset" },
      { amount: "10", currency: "INR", balance_type: "liability" }
    ],
    taxRecords: [
      { source: "itr", financial_year: "2025-26" },
      { source: "ais", financial_year: "2025-26" }
    ]
  });
  assert.equal(report.duplicate_holdings[0].occurrences, 2);
  assert.deepEqual(report.portfolio_totals[0], {
    currency: "INR",
    holdings: "150.00",
    assets: "25.00",
    liabilities: "10.00",
    net: "165.00",
    invalid_records: 0
  });
  assert.deepEqual(report.tax_year_completeness[0].missing_required, ["tax_statement"]);
  assert.equal(report.status, "warning");
});

test("marks broken bank arithmetic as an error", () => {
  const report = buildFinanceReconciliation({
    bankStatements: [
      {
        source: "bad.xls",
        transactions: [
          { credit: "100", balance: "1000" },
          { debit: "10", balance: "500" },
          { credit: "5", balance: "900" }
        ]
      }
    ],
    holdings: [],
    balances: [],
    taxRecords: []
  });
  assert.equal(report.bank_balances[0].status, "error");
  assert.equal(report.status, "error");
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildInvestmentHistoryAudit } from "./investment_history_audit";

test("classifies reconciled current and closed histories as return-capable", () => {
  const report = buildInvestmentHistoryAudit({
    holdings: [{ key: "symbol:OPEN", name: "Open", units: 8, currency: "USD", platform: "A" }],
    trades: [
      {
        key: "symbol:OPEN",
        name: "Open",
        side: "buy",
        quantity: 10,
        currency: "USD",
        platform: "A"
      },
      {
        key: "symbol:OPEN",
        name: "Open",
        side: "sell",
        quantity: 2,
        currency: "USD",
        platform: "A"
      },
      {
        key: "symbol:CLOSED",
        name: "Closed",
        side: "buy",
        quantity: 4,
        currency: "USD",
        platform: "A"
      },
      {
        key: "symbol:CLOSED",
        name: "Closed",
        side: "sell",
        quantity: 4,
        currency: "USD",
        platform: "A"
      }
    ],
    generatedAt: new Date("2026-10-26T00:00:00Z")
  });
  assert.equal(report.summary.reliable_xirr, 1);
  assert.equal(report.summary.realized_return_only, 1);
  assert.equal(report.status, "ok");
});

test("flags holdings with absent or mismatched transaction history", () => {
  const report = buildInvestmentHistoryAudit({
    holdings: [
      { key: "symbol:NONE", name: "None", units: 3, currency: "INR", platform: "A" },
      { key: "symbol:GAP", name: "Gap", units: 5, currency: "INR", platform: "A" }
    ],
    trades: [
      { key: "symbol:GAP", name: "Gap", side: "buy", quantity: 3, currency: "INR", platform: "A" }
    ]
  });
  assert.equal(report.summary.current_value_only, 2);
  assert.deepEqual(report.investments.find((row) => row.key === "symbol:NONE")?.reasons, [
    "no_transaction_history"
  ]);
  assert.deepEqual(report.investments.find((row) => row.key === "symbol:GAP")?.reasons, [
    "unit_mismatch"
  ]);
  assert.equal(report.status, "warning");
});

test("marks negative units, missing holdings, and mixed currencies invalid", () => {
  const report = buildInvestmentHistoryAudit({
    holdings: [{ key: "symbol:FX", name: "FX", units: 1, currency: "USD", platform: "A" }],
    trades: [
      {
        key: "symbol:NEG",
        name: "Negative",
        side: "sell",
        quantity: 2,
        currency: "INR",
        platform: "A"
      },
      { key: "symbol:FX", name: "FX", side: "buy", quantity: 1, currency: "INR", platform: "A" }
    ]
  });
  assert.equal(report.summary.invalid, 2);
  assert.ok(
    report.investments
      .find((row) => row.key === "symbol:NEG")
      ?.reasons.includes("negative_transaction_units")
  );
  assert.deepEqual(report.investments.find((row) => row.key === "symbol:FX")?.reasons, [
    "currency_mismatch"
  ]);
  assert.equal(report.status, "error");
});

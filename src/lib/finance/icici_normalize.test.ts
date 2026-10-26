import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifyICICI, normalizeICICIRows } from "./icici_normalize";
import type { ICICIRawRow } from "./icici_xls";

const source = {
  contentSha256: "a".repeat(64),
  importId: "b".repeat(64),
  originalPath: "banking/icici/statement.xls",
};

function row(overrides: Partial<ICICIRawRow> = {}): ICICIRawRow {
  return {
    sourceRow: 14,
    valueDate: "02/02/2026",
    transactionDate: "01/02/2026",
    chequeNumber: null,
    transactionRemarks: "  original description  ",
    withdrawalAmount: "125.00",
    depositAmount: "0.00",
    balance: "875.00",
    ...overrides,
  };
}

describe("ICICI transaction normalization", () => {
  test("normalizes dates, amounts, and provenance without altering description", () => {
    const result = normalizeICICIRows([row()], source);
    assert.equal(result.errors.length, 0);
    assert.equal(result.accepted.length, 1);
    const transaction = result.accepted[0];
    assert.equal(transaction.date, "2026-02-01");
    assert.equal(transaction.description, "  original description  ");
    assert.equal(transaction.debit, "125.00");
    assert.equal(transaction.credit, null);
    assert.equal(transaction.balance, "875.00");
    assert.equal(transaction.currency, "INR");
    assert.equal(transaction.source.record_locator, "OpTransactionHistory!row:14");
    assert.match(transaction.source_id, /^[a-f0-9]{64}$/);
    assert.equal(transaction.review_status, "needs_review");
  });

  test("uses the nonzero amount column for credits and creates stable IDs", () => {
    const creditRow = row({ withdrawalAmount: "0.00", depositAmount: "25.50" });
    const first = normalizeICICIRows([creditRow], source).accepted[0];
    const again = normalizeICICIRows([creditRow], source).accepted[0];
    assert.equal(first.debit, null);
    assert.equal(first.credit, "25.50");
    assert.equal(first.source_id, again.source_id);
  });

  test("rejects impossible dates, ambiguous amounts, and malformed money", () => {
    const result = normalizeICICIRows(
      [
        row({ transactionDate: "31/02/2026" }),
        row({ sourceRow: 15, withdrawalAmount: "10.00", depositAmount: "2.00" }),
        row({ sourceRow: 16, withdrawalAmount: "1,000.00" }),
      ],
      source,
    );
    assert.equal(result.accepted.length, 0);
    assert.deepEqual(
      result.errors.map((error) => error.code),
      ["invalid_transaction_date", "ambiguous_amount", "invalid_amount"],
    );
    assert.ok(result.errors.every((error) => !error.message.includes("original description")));
  });
});

describe("conservative ICICI classification", () => {
  const positives: Array<[string, string, string]> = [
    ["salary credit", "salary", "income"],
    ["mutual fund SIP", "investment", "investment"],
    ["transfer to own account", "transfer", "transfer"],
    ["home loan EMI", "loan_emi", "debt_repayment"],
    ["income tax payment", "tax", "tax"],
    ["credit card bill payment", "card_payment", "transfer"],
    ["NACH auto-debit", "recurring_expense", "spending"],
  ];

  for (const [description, category, classification] of positives) {
    test(`classifies a supported ${category} description`, () => {
      const result = classifyICICI(description);
      assert.equal(result.category, category);
      assert.equal(result.classification, classification);
    });
  }

  test("leaves weak evidence uncategorized and marks it for review", () => {
    const result = classifyICICI("UPI payment at local shop");
    assert.equal(result.category, null);
    assert.equal(result.classification, null);
    assert.equal(result.detail.confidence, "low");
    assert.equal(result.detail.review_needed, true);
  });

  const negatives = [
    ["tax", "TAXI ride"],
    ["loan", "EMILIA account"],
    ["card", "cardiology clinic"],
    ["investment", "SIPHON repair"],
    ["salary", "salaryman expense"],
    ["transfer", "transfer to supplier"],
    ["recurring", "NACHO meal"],
  ];
  for (const [rule, description] of negatives) {
    test(`does not match ${rule} from a similar but unsupported term`, () => {
      const result = classifyICICI(description);
      assert.equal(result.category, null);
      assert.equal(result.detail.rule, "uncategorized");
    });
  }

  test("uses tax precedence when a description contains multiple rule terms", () => {
    const result = classifyICICI("investment tax payment");
    assert.equal(result.category, "tax");
    assert.equal(result.detail.rule, "tax_payment");
  });

  test("keeps ambiguous recurring evidence reviewable", () => {
    const result = classifyICICI("NACH auto-debit");
    assert.equal(result.detail.confidence, "medium");
    assert.equal(result.detail.review_needed, true);
  });
});

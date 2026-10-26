import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseForm16PDF } from "./form16_pdf";
import { parseForm26ASPDF } from "./form26as_pdf";

test("parses the supplied Form 16 with reconciled summary arithmetic", async () => {
  const source = path.resolve("../My Finance/imports/tax/form-16/shubham-Form-16-meesho-904551_2025-26.pdf");
  const result = await parseForm16PDF(readFileSync(source));
  assert.ok(result.fields.length >= 10);
  assert.deepEqual(result.validations, { taxable_income_formula: true, tax_payable_formula: true, net_tax_matches_tds: true });
});

test("parses representative Form 26AS layouts without hardcoding private values", async () => {
  for (const year of [2010, 2018, 2022, 2025]) {
    const result = await parseForm26ASPDF(readFileSync(path.resolve(`../My Finance/imports/tax/form-26as/FJUPS6108D-${year}.pdf`)));
    assert.match(result.financial_year, /^20\d{2}-\d{2}$/);
    assert.equal(Number(result.totals.tax_deducted) >= 0, true);
    assert.equal(Number(result.totals.tax_deposited) >= 0, true);
    assert.equal(new Set(result.deductors.map((item) => item.record_locator)).size, result.deductors.length);
  }
});


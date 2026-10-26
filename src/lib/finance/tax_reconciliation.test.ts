import assert from "node:assert/strict";
import test from "node:test";
import { parseAisJson } from "./ais_json";
import { parseItrJson } from "./itr_json";
import { buildTaxReconciliation } from "./tax_reconciliation";
import type { AnnualTaxCredit } from "./annual_tax_statement";

const itr = (ay: string, tds: number, income: number) => parseItrJson({ ITR: { ITR2: { Form_ITR2: { AssessmentYear: ay }, "PartB-TI": { TotalIncome: income }, PartB_TTI: { TaxPaid: { TaxesPaid: { TDS: tds } } } } } }, `return-${ay}.json`);
const ais = (ay: string, tds: number) => parseAisJson({ AssessmentYear: ay, Tax: [{ RecordId: `total-${ay}`, Description: "Total TDS", TDSAmount: tds }] }, `ais-${ay}.json`);
const statement = (year: string, tds: string): AnnualTaxCredit => ({ record_type: "annual_tax_credit", source_id: `id-${year}`, financial_year: year, reported_period_label: year, section_code: "194A", transaction_date: null, amount_credited: "1000.00", tax_deducted: tds, tax_deposited: tds, currency: "INR", source: { import_id: `import-${year}`, original_path: `tax/statement-${year}.xlsx`, content_sha256: "hash", sheet_name: "Credits", record_locator: "Credits!row:2", financial_year_source: null } });

test("compares exact cross-source totals by year and retains linked sources without selecting a winner", () => {
  const report = buildTaxReconciliation({ itr: [itr("2024", 125, 5000), itr("2025", 175, 7000)], ais: [ais("2024", 125), ais("2025", 180)], annualTaxStatement: [statement("2023-24", "125"), statement("2024-25", "175")], generatedAt: new Date("2026-10-24T00:00:00Z") });
  assert.deepEqual(report.years, ["2023-24", "2024-25"]);
  assert.ok(report.variances.some((item) => item.financial_year === "2023-24" && item.metric === "tds" && item.status === "matches"));
  assert.ok(report.variances.some((item) => item.financial_year === "2024-25" && item.metric === "tds" && item.status === "difference" && item.difference === "5.00"));
  assert.ok(report.variances.every((item) => item.sources.every((source) => source.references.length > 0)));
});

test("deduplicates repeated imports of identical return bytes", () => {
  const record = itr("2024", 125, 5000);
  const report = buildTaxReconciliation({ itr: [record, record], ais: [], annualTaxStatement: [] });
  assert.equal(report.metrics.length, 2);
});

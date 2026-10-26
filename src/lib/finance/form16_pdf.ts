import { decimalText, extractVisualLines, type VisualLine } from "./pdf_layout";

export const FORM16_PARSER_VERSION = "form16-pdf/1";
export type Form16Field = { key: string; label: string; value: string; source_page: number; record_locator: string };
export type Form16Record = {
  record_type: "form16_summary";
  assessment_year: string;
  financial_year: string;
  fields: Form16Field[];
  validations: { taxable_income_formula: boolean; tax_payable_formula: boolean; net_tax_matches_tds: boolean };
};

const fieldPatterns: Array<[string, RegExp]> = [
  ["gross_salary", /^\(d\)\s*Total\s+/i],
  ["salary_current_employer", /^3\.\s*Total amount of salary received from current employer/i],
  ["section_16_deductions", /^5\.\s*Total amount of deductions under section 16/i],
  ["salary_income", /^6\.\s*Income chargeable under the head/i],
  ["gross_total_income", /^9\.\s*Gross total income/i],
  ["chapter_vi_a_deductions", /^11\.\s+/i],
  ["taxable_income", /^12\.\s*Total taxable income/i],
  ["tax_on_total_income", /^13\.\s*Tax on total income/i],
  ["rebate_87a", /^14\.\s*Rebate under section 87A/i],
  ["surcharge", /^15\.\s*Surcharge/i],
  ["cess", /^16\.\s*Health and education cess/i],
  ["tax_payable", /^17\.\s*Tax payable/i],
  ["net_tax_payable", /^21\.\s*Net tax payable/i]
];

function rightmostMoney(line: VisualLine): string | null {
  for (const item of [...line.items].sort((a, b) => b.x - a.x)) {
    const value = decimalText(item.text);
    if (value !== null) return value;
  }
  return null;
}

function field(lines: VisualLine[], key: string, pattern: RegExp): Form16Field | null {
  const line = lines.find((candidate) => pattern.test(candidate.text));
  if (!line) return null;
  const value = rightmostMoney(line);
  return value === null ? null : { key, label: line.text.replace(/\s+-?\d[\d,.]*$/, "").trim(), value, source_page: line.page, record_locator: `page:${line.page}:y:${line.y.toFixed(1)}` };
}

const amount = (fields: Form16Field[], key: string) => Number(fields.find((item) => item.key === key)?.value ?? Number.NaN);

export async function parseForm16PDF(input: Buffer): Promise<Form16Record> {
  const lines = await extractVisualLines(input);
  const joined = lines.map((line) => line.text).join("\n");
  if (!/FORM NO\.\s*16/i.test(joined) || !/PART B/i.test(joined)) throw new Error("Unsupported Form 16 PDF layout.");
  const year = /Assessment Year\s*:?\s*(20\d{2})-(\d{2})/i.exec(joined);
  if (!year) throw new Error("Form 16 assessment year could not be identified.");
  const fields = fieldPatterns.map(([key, pattern]) => field(lines, key, pattern)).filter((item): item is Form16Field => item !== null);
  const required = ["gross_salary", "section_16_deductions", "salary_income", "gross_total_income", "chapter_vi_a_deductions", "taxable_income", "tax_on_total_income", "surcharge", "cess", "tax_payable", "net_tax_payable"];
  const missing = required.filter((key) => !fields.some((item) => item.key === key));
  if (missing.length) throw new Error(`Form 16 required summary fields are missing: ${missing.join(", ")}.`);
  const eq = (left: number, right: number) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.01;
  const taxableIncomeFormula = eq(amount(fields, "taxable_income"), amount(fields, "gross_total_income") - amount(fields, "chapter_vi_a_deductions"));
  const taxPayableFormula = eq(amount(fields, "tax_payable"), amount(fields, "tax_on_total_income") + amount(fields, "surcharge") + amount(fields, "cess") - (Number.isFinite(amount(fields, "rebate_87a")) ? amount(fields, "rebate_87a") : 0));
  const netTaxMatchesTds = eq(amount(fields, "net_tax_payable"), amount(fields, "tax_payable"));
  if (!taxableIncomeFormula || !taxPayableFormula) throw new Error("Form 16 summary arithmetic did not reconcile.");
  const assessmentYear = `${year[1]}-${year[2]}`;
  return { record_type: "form16_summary", assessment_year: assessmentYear, financial_year: `${Number(year[1]) - 1}-${String((Number(year[1]) % 100)).padStart(2, "0")}`, fields, validations: { taxable_income_formula: taxableIncomeFormula, tax_payable_formula: taxPayableFormula, net_tax_matches_tds: netTaxMatchesTds } };
}


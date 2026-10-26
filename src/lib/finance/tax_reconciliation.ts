import type { AisJsonRecord } from "./ais_json";
import type { ItrJsonRecord } from "./itr_json";
import type { ItrXmlRecord } from "./itr_xml";
import type { AnnualTaxCredit } from "./annual_tax_statement";

type ItrRecord = ItrJsonRecord | ItrXmlRecord;
export type TaxMetric = { financial_year: string; metric: "total_income" | "tds"; source_type: "itr" | "ais" | "annual_tax_statement"; value: string; source_references: string[]; note?: string };
export type TaxVariance = { financial_year: string; metric: TaxMetric["metric"]; sources: Array<{ source_type: TaxMetric["source_type"]; value: string; references: string[] }>; difference: string; status: "difference" | "matches" };
export type TaxReconciliationReport = { generated_at: string; source_count: number; years: string[]; metrics: TaxMetric[]; variances: TaxVariance[]; unmatched: Array<{ financial_year: string; metric: TaxMetric["metric"]; sources_present: string[]; reason: string }> };

const amountText = (value: number | string) => typeof value === "number" ? value.toFixed(2) : value;
const ref = (path: string, sourcePath?: string) => sourcePath ? `${path}#${sourcePath}` : path;
function itrMetrics(record: ItrRecord): TaxMetric[] {
  const year = record.identity.financialYear?.value;
  if (!year) return [];
  const path = record.source.path ?? record.source.contentHash;
  const totalIncome = record.incomeHeads.find((item) => item.key === "totalIncome");
  const tds = record.taxes.find((item) => item.key === "tds");
  return [
    ...(totalIncome ? [{ financial_year: year, metric: "total_income" as const, source_type: "itr" as const, value: amountText(totalIncome.value), source_references: [ref(path, totalIncome.sourcePath)], note: record.identity.filingVersion }] : []),
    ...(tds ? [{ financial_year: year, metric: "tds" as const, source_type: "itr" as const, value: amountText(tds.value), source_references: [ref(path, tds.sourcePath)], note: record.identity.filingVersion }] : []),
  ];
}
function aisMetrics(record: AisJsonRecord): TaxMetric[] {
  const year = record.identity.financialYear?.value;
  if (!year) return [];
  const output: TaxMetric[] = [];
  const source = record.source.path ?? record.source.contentHash;
  for (const fact of record.facts) {
    const label = `${fact.section} ${fact.description?.value ?? ""}`.toLowerCase();
    const isTotalIncome = fact.category === "income" && /total\s+(?:gross\s+)?income|gross total income/.test(label);
    const isTotalTds = fact.category === "tax" && /total\s+(?:tds|tax deducted|tax withheld)/.test(label);
    if (isTotalIncome && fact.amount) output.push({ financial_year: year, metric: "total_income", source_type: "ais", value: amountText(fact.amount.value), source_references: [ref(source, fact.sourcePath)] });
    if (isTotalTds) {
      const value = fact.taxDeducted?.value ?? fact.amount?.value;
      if (value !== undefined) output.push({ financial_year: year, metric: "tds", source_type: "ais", value: amountText(value), source_references: [ref(source, fact.sourcePath)] });
    }
  }
  return output;
}
function statementMetrics(records: AnnualTaxCredit[]): TaxMetric[] {
  const byYear = new Map<string, AnnualTaxCredit[]>();
  for (const record of records) if (record.financial_year) byYear.set(record.financial_year, [...(byYear.get(record.financial_year) ?? []), record]);
  return [...byYear.entries()].map(([year, rows]) => ({ financial_year: year, metric: "tds" as const, source_type: "annual_tax_statement" as const, value: rows.reduce((sum, row) => sum + Number(row.tax_deducted ?? 0), 0).toFixed(2), source_references: rows.map((row) => `${row.source.original_path}#${row.source.record_locator}`), note: "Sum of imported withholding detail rows; verify section coverage before treating as a complete annual total." }));
}

/** Compare only explicit same-name totals; preserve all source values and references. */
export function buildTaxReconciliation(inputs: { itr: ItrRecord[]; ais: AisJsonRecord[]; annualTaxStatement: AnnualTaxCredit[]; generatedAt?: Date }): TaxReconciliationReport {
  const seenReturns = new Set<string>();
  const uniqueReturns = inputs.itr.filter((record) => {
    const identity = `${record.source.path ?? ""}\n${record.source.contentHash}`;
    if (seenReturns.has(identity)) return false;
    seenReturns.add(identity);
    return true;
  });
  const metrics = [...uniqueReturns.flatMap(itrMetrics), ...inputs.ais.flatMap(aisMetrics), ...statementMetrics(inputs.annualTaxStatement)];
  const grouped = new Map<string, TaxMetric[]>();
  for (const metric of metrics) { const key = `${metric.financial_year}\n${metric.metric}`; grouped.set(key, [...(grouped.get(key) ?? []), metric]); }
  const variances: TaxVariance[] = []; const unmatched: TaxReconciliationReport["unmatched"] = [];
  for (const [key, values] of grouped) {
    const [financial_year, metric] = key.split("\n") as [string, TaxMetric["metric"]];
    const sources = [...new Set(values.map((value) => value.source_type))];
    if (sources.length < 2) { unmatched.push({ financial_year, metric, sources_present: sources, reason: "Only one source supplies an explicit comparable total." }); continue; }
    const rounded = values.map((value) => Math.round(Number(value.value) * 100));
    const difference = (Math.max(...rounded) - Math.min(...rounded)) / 100;
    variances.push({ financial_year, metric, sources: values.map(({ source_type, value, source_references }) => ({ source_type, value, references: source_references })), difference: difference.toFixed(2), status: difference === 0 ? "matches" : "difference" });
  }
  return { generated_at: (inputs.generatedAt ?? new Date()).toISOString(), source_count: new Set(metrics.flatMap((metric) => metric.source_references)).size, years: [...new Set(metrics.map((metric) => metric.financial_year))].sort(), metrics, variances, unmatched };
}

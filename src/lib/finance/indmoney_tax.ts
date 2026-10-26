import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";

export const INDMONEY_TAX_IMPORT_VERSION = "1.0.0";
export type IndmoneyTaxRecord = {
  record_type: "indmoney_tax_summary";
  financial_year: string;
  summary_type: "capital_gain" | "dividend" | "interest" | "foreign_income" | "foreign_tax_credit" | "business_result";
  gain_type?: "short_term" | "long_term";
  asset_category?: string;
  amounts: Record<string, string>;
  currency: "INR";
  source: { sheet_name: string; source_row: number };
  possible_overlap: { detected: boolean; related_source_types: string[]; reason: string };
};
export type IndmoneyTaxError = { code: string; message: string; record_locator?: string };

const clean = (v: unknown) => String(v ?? "").trim();
const label = (v: unknown) => clean(v).toLowerCase().replace(/\s+/g, " ");
function amount(v: unknown): string | null {
  let s = clean(v).replace(/[₹$€£,\s]/g, "");
  if (!s || s === "-" || s === "—") return null;
  const parens = s.startsWith("(") && s.endsWith(")"); if (parens) s = s.slice(1, -1);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return null;
  const n = Number(s); return Number.isFinite(n) ? (parens ? -n : n).toFixed(2) : null;
}
function year(sheet: XLSX.WorkSheet): string | null {
  for (const key of Object.keys(sheet)) { const m = clean(sheet[key]?.v).match(/20\d{2}\s*[-–]\s*\d{2}/); if (m) return m[0].replace(/\s/g, ""); }
  return null;
}
function rowValues(sheet: XLSX.WorkSheet, r: number): unknown[] {
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1");
  return Array.from({ length: range.e.c - range.s.c + 1 }, (_, i) => sheet[XLSX.utils.encode_cell({ r, c: range.s.c + i })]?.v);
}
function summaryRecord(sheetName: string, row: number, fy: string, type: IndmoneyTaxRecord["summary_type"], category: string, values: Record<string, string>): IndmoneyTaxRecord {
  return { record_type: "indmoney_tax_summary", financial_year: fy, summary_type: type, ...(type === "capital_gain" ? { gain_type: sheetName === "LTCG" ? "long_term" as const : "short_term" as const } : {}), asset_category: category, amounts: values, currency: "INR", source: { sheet_name: sheetName, source_row: row }, possible_overlap: { detected: false, related_source_types: [], reason: "Not reconciled with other imports yet." } };
}

export function parseIndmoneyTax(input: string | Buffer): { records: IndmoneyTaxRecord[]; sheet_names: string[]; skipped_rows: number; errors: IndmoneyTaxError[] } {
  let wb: XLSX.WorkBook; try { wb = XLSX.read(typeof input === "string" ? readFileSync(input) : input, { type: "buffer", raw: true, cellDates: false }); } catch { throw new Error("INDmoney tax workbook could not be read as an Excel workbook."); }
  const records: IndmoneyTaxRecord[] = []; const errors: IndmoneyTaxError[] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]; const fy = year(sheet); if (!fy) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, blankrows: true }) as unknown[][];
    for (let i = 0; i < rows.length; i++) {
      const vals = rows[i]; const text = vals.map(clean); const first = text.find(Boolean) ?? ""; const lower = label(first);
      let type: IndmoneyTaxRecord["summary_type"] | null = null; let gain: boolean = false;
      if ((name === "LTCG" || name === "STCG") && i < 30 && (lower === "equity" || lower.startsWith("non")) && text.length >= 6 && text.slice(1, 6).some(v => amount(v) !== null)) { type = "capital_gain"; gain = true; }
      else if (name === "Dividend" && (lower === "us stocks" || lower === "total" || lower === "indian stocks" || lower === "mutual funds" || lower === "buybacks") && amount(vals[1]) !== null) type = "dividend";
      else if (name === "Interest" && (lower === "total" || lower.includes("interest")) && amount(vals[1]) !== null) type = "interest";
      else if (name === "Schedule FSI" && (lower === "capital gains" || lower === "other sources" || lower === "total") && amount(vals[2]) !== null) type = "foreign_income";
      else if (name === "Form 67" && vals.length >= 5 && (lower === "1" || lower === "2") && amount(vals[3]) !== null) type = "foreign_tax_credit";
      else if (name === "Schedule TR" && vals.length >= 3 && amount(vals[2]) !== null) type = "foreign_tax_credit";
      else if ((name === "F&O" || name === "Intraday") && (lower === "total" || lower.includes("taxable gains")) && amount(vals[1]) !== null) type = "business_result";
      if (!type) continue;
      const nums: Record<string, string> = {}; const headers = type === "capital_gain" ? ["sell_value", "buy_value", "expense", "disallowed_loss", "taxable_gain"] : ["amount", "tax_paid", "tax_relief"];
      const categoryIndex = vals.findIndex(v => clean(v) === first); const start = type === "capital_gain" ? categoryIndex + 1 : name === "Schedule FSI" ? 2 : name === "Schedule TR" ? 2 : name === "Form 67" ? 3 : 1;
      for (let j = 0; j < headers.length; j++) { const v = amount(vals[start + j]); if (v !== null) nums[headers[j]] = v; }
      records.push(summaryRecord(name, i + 1, fy, type, first, nums));
    }
  }
  if (!records.length) throw new Error("Unexpected INDmoney tax workbook layout: no tax summary rows found.");
  return { records, sheet_names: wb.SheetNames, skipped_rows: 0, errors };
}

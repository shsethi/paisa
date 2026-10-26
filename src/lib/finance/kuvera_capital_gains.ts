import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";

export const KUVERA_CAPITAL_GAINS_IMPORT_VERSION = "1.0.0";

export type KuveraGainType = "short_term" | "long_term";

export type KuveraCapitalGain = {
  record_type: "kuvera_realized_gain_summary";
  financial_year: string;
  gain_type: KuveraGainType;
  realized_gain: string;
  currency: "INR";
  source: { sheet_name: string; source_row: number };
};

export type KuveraCapitalGainError = { code: string; message: string; record_locator?: string };

export type KuveraCapitalGainParseResult = {
  records: KuveraCapitalGain[];
  sheet_names: string[];
  skipped_sheets: string[];
  skipped_rows: number;
  errors: KuveraCapitalGainError[];
};

function text(value: unknown): string { return value === null || value === undefined ? "" : String(value).trim(); }
function label(value: unknown): string { return text(value).toLowerCase().replace(/\s+/g, " "); }

function parseFinancialYear(value: unknown): string | null {
  const match = text(value).match(/(?:fy|financial\s+year)?\s*(20\d{2})\s*[-–/]\s*(\d{2}|20\d{2})/i);
  if (!match) return null;
  return `${match[1]}-${match[2].length === 2 ? match[2] : match[2].slice(-2)}`;
}

function parseAmount(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(2);
  let raw = text(value).replace(/[₹$€£,\s]/g, "");
  if (!raw) return null;
  const negative = raw.startsWith("(") && raw.endsWith(")");
  if (negative) raw = raw.slice(1, -1);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return null;
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return null;
  return (negative ? -amount : amount).toFixed(2);
}

function cell(sheet: XLSX.WorkSheet, row: number, column: number): unknown {
  return sheet[XLSX.utils.encode_cell({ r: row, c: column })]?.v;
}

export function parseKuveraCapitalGains(input: string | Buffer): KuveraCapitalGainParseResult {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(typeof input === "string" ? readFileSync(input) : input, { type: "buffer", raw: true, cellDates: false });
  } catch { throw new Error("Kuvera capital-gains workbook could not be read as an Excel workbook."); }

  const records: KuveraCapitalGain[] = [];
  const errors: KuveraCapitalGainError[] = [];
  const skippedSheets: string[] = [];
  let skippedRows = 0;
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet["!ref"]) { skippedSheets.push(sheetName); continue; }
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    let financialYear: string | null = null;
    const summaries: Array<{ type: KuveraGainType; row: number; value: unknown }> = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const rowValues = Array.from({ length: range.e.c - range.s.c + 1 }, (_, i) => cell(sheet, r, range.s.c + i));
      for (let c = 0; c < rowValues.length; c++) {
        const current = rowValues[c];
        if (label(current) === "statement period") financialYear = parseFinancialYear(rowValues[c + 1]);
        if (label(current).includes("short term capital gains")) summaries.push({ type: "short_term", row: r + 1, value: rowValues[c + 1] });
        if (label(current).includes("long term capital gains")) summaries.push({ type: "long_term", row: r + 1, value: rowValues[c + 1] });
      }
    }
    if (summaries.length === 0) { skippedSheets.push(sheetName); continue; }
    for (const summary of summaries) {
      const locator = `${sheetName} row ${summary.row}`;
      if (!financialYear) { errors.push({ code: "missing_financial_year", message: "Financial year is missing or not recognized.", record_locator: locator }); continue; }
      const realizedGain = parseAmount(summary.value);
      if (realizedGain === null) { errors.push({ code: "missing_or_invalid_amount", message: "Capital-gain amount is missing or not numeric.", record_locator: locator }); continue; }
      records.push({ record_type: "kuvera_realized_gain_summary", financial_year: financialYear, gain_type: summary.type, realized_gain: realizedGain, currency: "INR", source: { sheet_name: sheetName, source_row: summary.row } });
    }
    skippedRows += Math.max(0, range.e.r - range.s.r + 1 - summaries.length);
  }
  if (records.length === 0 && errors.length === 0) throw new Error("Unexpected Kuvera capital-gains workbook layout: no capital-gain summary rows found.");
  return { records, sheet_names: workbook.SheetNames, skipped_sheets: skippedSheets, skipped_rows: skippedRows, errors };
}

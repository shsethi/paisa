import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";

export const ZERODHA_PNL_PARSER_VERSION = "1.0.0";

export type ZerodhaPnlGainType = "short_term" | "long_term" | "intraday" | "other";

export type ZerodhaPnlRecord = {
  record_type: "zerodha_realized_gain_summary";
  financial_year: string;
  security: string;
  gain_type: ZerodhaPnlGainType;
  buy_value: string | null;
  sell_value: string | null;
  realized_gain: string;
  charges: string | null;
  currency: "INR";
  source: { sheet_name: string; source_row: number };
};

export type ZerodhaPnlParseResult = {
  records: ZerodhaPnlRecord[];
  sheet_names: string[];
  skipped_sheets: string[];
  skipped_rows: number;
};

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function number(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(2);
  const raw = text(value).replaceAll(",", "").replace(/[₹$]/g, "");
  if (!raw || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : null;
}

function normalize(value: unknown): string {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function financialYear(sheet: XLSX.WorkSheet, fileName?: string): string | null {
  const cells = Object.values(sheet)
    .filter((cell): cell is XLSX.CellObject => Boolean(cell && typeof cell === "object" && "v" in cell))
    .map((cell) => text(cell.v))
    .join(" ");
  const april = cells.match(/(20\d{2})[-/]04[-/]01/);
  if (april) return `${april[1]}-${String(Number(april[1].slice(-2)) + 1).padStart(2, "0")}`;
  const match = cells.match(/(?:financial\s+year|fy)\s*:?[\s-]*(20\d{2})\s*[-_/–]\s*(\d{2}|20\d{2})/i) ??
    `${fileName ?? ""} ${cells}`.match(/(20\d{2})\s*[_-]\s*(20\d{2})/i) ??
    `${fileName ?? ""} ${cells}`.match(/(20\d{2})\s*[-_/–]\s*(\d{2})(?!\d)/i);
  if (!match) return null;
  const end = match[2].length === 2 ? match[2] : match[2].slice(-2);
  return `${match[1]}-${end}`;
}

function gainType(value: string): ZerodhaPnlGainType {
  const label = normalize(value);
  if (label.includes("short")) return "short_term";
  if (label.includes("long")) return "long_term";
  if (label.includes("intraday") || label.includes("day trade")) return "intraday";
  return "other";
}

function isSecurityHeader(value: string): boolean {
  return /^(security|instrument|symbol|scrip|scrip name|security name|tradingsymbol|name)$/.test(value);
}

function isGainHeader(value: string): boolean {
  return /(?:gain|profit|loss|p ?& ?l)/.test(value);
}

function isExcludedSheet(name: string): boolean {
  return /open positions|dividends|interest|ledger balances/i.test(name);
}

function isTotal(value: string): boolean {
  return /^(total|grand total|subtotal|net total)$/i.test(value);
}

function parseSheet(sheetName: string, sheet: XLSX.WorkSheet, fy: string): { records: ZerodhaPnlRecord[]; skipped: number } {
  if (!sheet["!ref"]) return { records: [], skipped: 0 };
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const records: ZerodhaPnlRecord[] = [];
  let skipped = 0;
  let section = "";
  for (let r = range.s.r; r <= range.e.r; r++) {
    const values = Array.from({ length: range.e.c - range.s.c + 1 }, (_, i) => sheet[XLSX.utils.encode_cell({ r, c: range.s.c + i })]?.v);
    const labels = values.map(normalize);
    const securityColumn = labels.findIndex(isSecurityHeader);
    const gainColumn = labels.findIndex(isGainHeader);
    if (securityColumn >= 0 && gainColumn >= 0 && labels.some((v) => /buy|sell|purchase|sale|cost|turnover/.test(v))) {
      const columns = {
        security: securityColumn,
        buy: labels.findIndex((v) => /buy.*(?:value|amount)|purchase|cost/.test(v)),
        sell: labels.findIndex((v) => /sell.*(?:value|amount)|sale/.test(v)),
        gain: gainColumn,
        charges: labels.findIndex((v) => /charge|expense|brokerage|stt|tax/.test(v)),
      };
      for (let dataRow = r + 1; dataRow <= range.e.r; dataRow++) {
        const row = Array.from({ length: range.e.c - range.s.c + 1 }, (_, i) => sheet[XLSX.utils.encode_cell({ r: dataRow, c: range.s.c + i })]?.v);
        const security = text(row[columns.security]);
        if (!security) break;
        if (isTotal(security)) { skipped++; continue; }
        const realized = number(row[columns.gain]);
        if (realized === null) { skipped++; continue; }
        records.push({
          record_type: "zerodha_realized_gain_summary",
          financial_year: fy,
          security,
          gain_type: gainType(section),
          buy_value: columns.buy >= 0 ? number(row[columns.buy]) : null,
          sell_value: columns.sell >= 0 ? number(row[columns.sell]) : null,
          realized_gain: realized,
          charges: columns.charges >= 0 ? number(row[columns.charges]) : null,
          currency: "INR",
          source: { sheet_name: sheetName, source_row: dataRow + 1 },
        });
      }
      continue;
    }
    const rowText = labels.filter(Boolean).join(" ");
    if (rowText) {
      if (/short term|short term capital|short/.test(rowText)) section = "short";
      else if (/long term|long term capital|long/.test(rowText)) section = "long";
      else if (/intraday|day trade/.test(rowText)) section = "intraday";
    }

    // Zerodha's asset-class tabs also expose compact gain summaries without a
    // security column. Keep those as asset-level summary records, separate
    // from tradebook rows, when a labeled amount is present near the summary.
    if (r < 24 && values[0] !== undefined && typeof values[0] === "string" &&
        /gain|profit|loss|p ?& ?l|turnover|charges|tax/.test(normalize(values[0]))) {
      const amount = values.slice(1).map(number).find((value) => value !== null) ?? null;
      if (amount !== null) {
        records.push({
          record_type: "zerodha_realized_gain_summary",
          financial_year: fy,
          security: sheetName,
          gain_type: gainType(text(values[0])),
          buy_value: null,
          sell_value: null,
          realized_gain: amount,
          charges: /charge|tax/.test(normalize(values[0])) ? amount : null,
          currency: "INR",
          source: { sheet_name: sheetName, source_row: r + 1 },
        });
      }
    }
  }
  return { records, skipped };
}

export function parseZerodhaPnl(input: string | Buffer): ZerodhaPnlParseResult {
  let workbook: XLSX.WorkBook;
  try {
    const data = typeof input === "string" ? readFileSync(input) : input;
    workbook = XLSX.read(data, { type: "buffer", raw: true, cellDates: false });
  } catch {
    throw new Error("Zerodha P&L workbook could not be read as an Excel workbook");
  }
  const records: ZerodhaPnlRecord[] = [];
  const skippedSheets: string[] = [];
  let skippedRows = 0;
  for (const sheetName of workbook.SheetNames) {
    if (isExcludedSheet(sheetName)) { skippedSheets.push(sheetName); continue; }
    const sheet = workbook.Sheets[sheetName];
    const fy = financialYear(sheet, sheetName);
    if (!fy) { skippedSheets.push(sheetName); continue; }
    const parsed = parseSheet(sheetName, sheet, fy);
    records.push(...parsed.records);
    skippedRows += parsed.skipped;
  }
  return { records, sheet_names: workbook.SheetNames, skipped_sheets: skippedSheets, skipped_rows: skippedRows };
}

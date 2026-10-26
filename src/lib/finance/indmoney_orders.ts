import * as XLSX from "xlsx";

export const INDMONEY_ORDER_HEADERS = {
  date: ["order date", "trade date", "executed date", "date", "order placed date"],
  instrument: ["instrument", "symbol", "scrip", "scrip name", "stock name", "security", "asset name"],
  action: ["action", "order type", "transaction type", "buy sell", "side"],
  quantity: ["quantity", "qty", "units"],
  price: ["price", "average price", "executed price", "order price"],
  amount: ["amount", "total amount", "order value", "trade value", "net amount"],
  currency: ["currency", "ccy"],
  fees: ["fees", "fee", "charges", "brokerage", "transaction charges", "total charges"],
} as const;

export type IndmoneyOrderRawRow = { sourceRow: number; sheetName: string; values: Record<string, string>; rowWidth: number };
export type IndmoneyOrderParseResult = { rows: IndmoneyOrderRawRow[]; readRows: number; skippedBlankRows: number; sheetName: string; headers: string[] };

const norm = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const cell = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return String(value).trim();
};
const blank = (row: unknown[]) => row.every((value) => cell(value) === "");
function headerIndex(labels: string[], names: readonly string[]): number {
  const exact = labels.findIndex((label) => names.includes(label)); if (exact >= 0) return exact;
  const family = names[0];
  if (family === "order date") return labels.findIndex((label) => /date|time/.test(label));
  if (family === "instrument") return labels.findIndex((label) => /instrument|symbol|scrip|stock|security|asset|company|fund/.test(label));
  if (family === "action") return labels.findIndex((label) => /action|side|buy|sell|order type|transaction|type/.test(label));
  if (family === "quantity") return labels.findIndex((label) => /quantity|qty|unit/.test(label));
  if (family === "price") return labels.findIndex((label) => /price|rate/.test(label));
  if (family === "amount") return labels.findIndex((label) => /amount|value|total|consideration/.test(label));
  if (family === "currency") return labels.findIndex((label) => /currency|ccy|curr/.test(label));
  if (family === "fees") return labels.findIndex((label) => /fee|charge|brokerage|tax/.test(label));
  return -1;
}

export function parseIndmoneyOrders(input: Buffer | string): IndmoneyOrderParseResult {
  let workbook: XLSX.WorkBook;
  try { workbook = XLSX.read(input, { type: typeof input === "string" ? "file" : "buffer", raw: true, cellDates: false }); }
  catch { throw new Error("INDmoney order workbook could not be read as an Excel workbook"); }
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]; if (!sheet["!ref"]) continue;
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 40); r++) {
      const values = Array.from({ length: range.e.c - range.s.c + 1 }, (_, i) => sheet[XLSX.utils.encode_cell({ r, c: range.s.c + i })]?.v);
      const labels = values.map(norm);
      const found = Object.fromEntries(Object.entries(INDMONEY_ORDER_HEADERS).map(([key, names]) => [key, headerIndex(labels, names)]));
      if (found.date < 0 || found.instrument < 0 || found.action < 0 || found.quantity < 0 || (found.price < 0 && found.amount < 0)) continue;
      const headers = values.map(cell);
      const rows: IndmoneyOrderRawRow[] = []; let skippedBlankRows = 0;
      for (let dataRow = r + 1; dataRow <= range.e.r; dataRow++) {
        const row = Array.from({ length: range.e.c - range.s.c + 1 }, (_, i) => sheet[XLSX.utils.encode_cell({ r: dataRow, c: range.s.c + i })]?.v);
        if (blank(row)) { skippedBlankRows++; continue; }
        const valuesByHeader: Record<string, string> = {};
        headers.forEach((header, i) => { if (header) valuesByHeader[header] = cell(row[i]); });
        rows.push({ sourceRow: dataRow + 1, sheetName, values: valuesByHeader, rowWidth: row.length });
      }
      return { rows, readRows: rows.length, skippedBlankRows, sheetName, headers };
    }
  }
  throw new Error("Unexpected INDmoney order workbook layout: supported order headers were not found.");
}


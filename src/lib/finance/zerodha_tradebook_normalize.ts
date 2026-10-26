import { createHash } from "node:crypto";
import type { ZerodhaTradebookRawRow } from "./zerodha_tradebook";

export type ZerodhaTrade = {
  record_type: "zerodha_trade";
  source_id: string;
  trade_date: string;
  instrument: string;
  isin: string;
  side: "buy" | "sell";
  quantity: string;
  price: string;
  currency: "INR";
  exchange: string;
  segment: string;
  series: string;
  trade_id: string;
  order_id: string;
  order_execution_time: string;
  auction: string;
  source: { import_id: string; original_path: string; content_sha256: string; record_locator: string };
  review_status: "needs_review";
};

export type ZerodhaTradebookNormalizationError = { code: string; message: string; record_locator: string };
export type ZerodhaTradebookNormalizationResult = { accepted: ZerodhaTrade[]; errors: ZerodhaTradebookNormalizationError[] };

type Context = { contentSha256: string; importId: string; originalPath: string };

function decimal(value: string, allowZero = false): string | null {
  if (!/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const [integer, fraction] = value.trim().split(".");
  if (!allowZero && !/[1-9]/.test(integer + (fraction ?? ""))) return null;
  return integer.replace(/^0+(?=\d)/, "") + (fraction === undefined ? "" : `.${fraction}`);
}

function date(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const check = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== value ? null : value;
}

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

export function normalizeZerodhaTradebookRows(rows: ZerodhaTradebookRawRow[], context: Context): ZerodhaTradebookNormalizationResult {
  const accepted: ZerodhaTrade[] = [];
  const errors: ZerodhaTradebookNormalizationError[] = [];
  for (const row of rows) {
    const recordLocator = `tradebook!row:${row.sourceRow}`;
    const reject = (code: string, message: string) => errors.push({ code, message, record_locator: recordLocator });
    if (row.rowWidth !== 13) { reject("malformed_row", "Tradebook row has an unsupported number of columns."); continue; }
    const tradeDate = date(row.trade_date);
    const quantity = decimal(row.quantity);
    const price = decimal(row.price, true);
    const side = row.trade_type.toLowerCase();
    if (!tradeDate) { reject("invalid_trade_date", "Trade date is missing or invalid."); continue; }
    if (!row.symbol || !row.isin) { reject("missing_instrument", "Instrument identifier is missing."); continue; }
    if (side !== "buy" && side !== "sell") { reject("invalid_trade_type", "Trade type must be BUY or SELL."); continue; }
    if (!quantity) { reject("invalid_quantity", "Quantity must be a positive number."); continue; }
    if (price === null) { reject("invalid_price", "Price must be a non-negative number."); continue; }
    accepted.push({
      record_type: "zerodha_trade", source_id: sha256(`zerodha_tradebook\n${context.contentSha256}\n${recordLocator}`),
      trade_date: tradeDate, instrument: row.symbol, isin: row.isin, side: side as "buy" | "sell",
      quantity, price, currency: "INR", exchange: row.exchange, segment: row.segment, series: row.series,
      trade_id: row.trade_id, order_id: row.order_id, order_execution_time: row.order_execution_time,
      auction: row.auction, source: { import_id: context.importId, original_path: context.originalPath, content_sha256: context.contentSha256, record_locator: recordLocator },
      review_status: "needs_review",
    });
  }
  return { accepted, errors };
}

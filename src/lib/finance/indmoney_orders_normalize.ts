import { createHash } from "node:crypto";
import type { IndmoneyOrderRawRow } from "./indmoney_orders";

export type IndmoneyOrder = {
  record_type: "indmoney_order"; source_id: string; date: string; instrument: string; action: "buy" | "sell" | "other";
  quantity: string; price: string | null; amount: string | null; currency: string; fees: string | null;
  original_values: Record<string, string>; source: { import_id: string; original_path: string; content_sha256: string; record_locator: string; sheet_name: string; source_row: number };
  flags: string[]; review_status: "needs_review";
};
export type IndmoneyOrderNormalizationError = { code: string; message: string; record_locator: string };
export type IndmoneyOrderNormalizationResult = { accepted: IndmoneyOrder[]; errors: IndmoneyOrderNormalizationError[] };
type Context = { contentSha256: string; importId: string; originalPath: string };
const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const pick = (values: Record<string, string>, names: string[]) => { const wanted = names.map(norm); const key = Object.keys(values).find((k) => wanted.includes(norm(k)) || (names[0] === "order date" && /date|time/i.test(k)) || (names[0] === "instrument" && /instrument|symbol|scrip|stock|security|asset|company|fund/i.test(k)) || (names[0] === "action" && /action|side|buy|sell|order type|transaction|type/i.test(k)) || (names[0] === "quantity" && /quantity|qty|unit/i.test(k)) || (names[0] === "price" && /price|rate/i.test(k)) || (names[0] === "amount" && /amount|value|total|consideration/i.test(k)) || (names[0] === "currency" && /currency|ccy|curr/i.test(k)) || (names[0] === "fees" && /fee|charge|brokerage|tax/i.test(k))); return key ? values[key] : ""; };
function decimal(v: string, allowZero = true): string | null { const s = v.replaceAll(",", "").replace(/[₹$€£]/g, "").trim(); if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return null; const n = Number(s); return Number.isFinite(n) && (allowZero || n > 0) ? String(n) : null; }
function date(v: string): string | null { const s = v.trim(); const serial = Number(s); if (/^\d+(?:\.\d+)?$/.test(s) && serial > 20000 && serial < 80000) { const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000); return d.toISOString().slice(0, 10); } const match = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/); let iso = /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : match ? `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}` : null; if (!iso) { const parsed = Date.parse(s); if (Number.isFinite(parsed)) iso = new Date(parsed).toISOString().slice(0, 10); } if (!iso) return null; const d = new Date(`${iso}T00:00:00Z`); return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso; }
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
export function normalizeIndmoneyOrderRows(rows: IndmoneyOrderRawRow[], context: Context): IndmoneyOrderNormalizationResult {
  const accepted: IndmoneyOrder[] = []; const errors: IndmoneyOrderNormalizationError[] = [];
  for (const row of rows) {
    const locator = `${row.sheetName}!row:${row.sourceRow}`; const reject = (code: string, message: string) => errors.push({ code, message, record_locator: locator });
    const dateValue = date(pick(row.values, ["order date", "trade date", "executed date", "date", "order placed date"]));
    const instrument = pick(row.values, ["instrument", "symbol", "scrip", "scrip name", "stock name", "security", "asset name"]);
    const actionRaw = norm(pick(row.values, ["action", "order type", "transaction type", "buy sell", "side"]));
    const quantity = decimal(pick(row.values, ["quantity", "qty", "units"]), false);
    const price = decimal(pick(row.values, ["price", "average price", "executed price", "order price"]));
    const amount = decimal(pick(row.values, ["amount", "total amount", "order value", "trade value", "net amount"]));
    if (!dateValue) { reject("invalid_date", "Order date is missing or invalid."); continue; }
    if (!instrument) { reject("missing_instrument", "Instrument is missing."); continue; }
    if (!quantity) { reject("invalid_quantity", "Quantity must be a positive number."); continue; }
    if (price === null && amount === null) { reject("missing_value", "Price or amount is required."); continue; }
    const action: IndmoneyOrder["action"] = /^(buy|purchase|bought)$/.test(actionRaw) ? "buy" : /^(sell|sale|sold)$/.test(actionRaw) ? "sell" : "other";
    const currency = (pick(row.values, ["currency", "ccy"]) || "INR").toUpperCase();
    const flags: string[] = []; if (action === "other") flags.push("unsupported_action"); if (!/^[A-Z]{3}$/.test(currency) || !["INR", "USD", "EUR", "GBP", "AED", "SGD"].includes(currency)) flags.push("unsupported_currency");
    const originalValues = { ...row.values };
    accepted.push({ record_type: "indmoney_order", source_id: sha(`indmoney_order\n${context.contentSha256}\n${locator}`), date: dateValue, instrument, action, quantity, price, amount, currency, fees: decimal(pick(row.values, ["fees", "fee", "charges", "brokerage", "transaction charges", "total charges"])), original_values: originalValues, source: { import_id: context.importId, original_path: context.originalPath, content_sha256: context.contentSha256, record_locator: locator, sheet_name: row.sheetName, source_row: row.sourceRow }, flags, review_status: "needs_review" });
  }
  return { accepted, errors };
}


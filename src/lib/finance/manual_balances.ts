import Papa from "papaparse";

export const MANUAL_BALANCES_IMPORT_VERSION = "1.0.0";

export type ManualBalanceType = "asset" | "liability" | "cash_flow";
export type ManualBalance = {
  record_type: "manual_balance";
  source_id: string;
  balance_type: ManualBalanceType;
  category: string;
  label: string | null;
  owner: string | null;
  account_label: string | null;
  amount: string | null;
  currency: string | null;
  as_of_date: string;
  date_precision: "month";
  source: { import_id: string; original_path: string; content_sha256: string; record_locator: string };
  review_status: "needs_review";
  review_reasons: string[];
};

export type ManualBalanceError = { code: string; message: string; record_locator?: string };
export type ManualBalancesParseResult = { rows: ManualBalance[]; readRows: number; skippedRows: number; errors: ManualBalanceError[]; asOfDate: string };

type CellRow = string[];
const clean = (v: unknown): string => String(v ?? "").trim();
const amount = (v: string): string | null => {
  const value = v.trim().replace(/^₹\s*/, "").replaceAll(",", "");
  if (!value || value === "-") return null;
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const [whole, fraction] = value.split(".");
  const normalized = whole.replace(/^(-?)0+(?=\d)/, "$1") || "0";
  return fraction === undefined ? normalized : `${normalized}.${fraction}`;
};
const nonempty = (v: string): string | null => v ? v : null;

function snapshotDate(fileName?: string): string {
  const match = (fileName ?? "").match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[^\d]*(20\d{2})\b/i);
  if (!match) return "";
  const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(match[1].slice(0, 3).toLowerCase()) + 1;
  return month > 0 ? `${match[2]}-${String(month).padStart(2, "0")}-01` : "";
}

export function parseManualBalancesCSV(input: string | Buffer, fileName?: string): ManualBalancesParseResult {
  const text = typeof input === "string" ? input : input.toString("utf8");
  const parsed = Papa.parse<CellRow>(text.replace(/^\uFEFF/, ""), { header: false, skipEmptyLines: false });
  if (parsed.errors.length) throw new Error("Manual balances CSV could not be parsed: malformed CSV.");
  const asOfDate = snapshotDate(fileName);
  if (!asOfDate) throw new Error("Manual balances filename must include a month and four-digit year.");
  const rows = parsed.data;
  const records: ManualBalance[] = [];
  const errors: ManualBalanceError[] = [];
  let skippedRows = 0;
  let section = "";
  let financialHeader = false;
  const push = (type: ManualBalanceType, category: string, label: string | null, owner: string | null, value: string, rowNo: number, account: string | null = null, reason?: string) => {
    const parsedAmount = amount(value);
    if (value && parsedAmount === null && value !== "-") errors.push({ code: "invalid_amount", message: "Amount is not numeric.", record_locator: `csv row ${rowNo}` });
    records.push({ record_type: "manual_balance", source_id: "", balance_type: type, category, label, owner, account_label: account, amount: parsedAmount, currency: parsedAmount === null ? null : "INR", as_of_date: asOfDate, date_precision: "month", source: { import_id: "", original_path: "", content_sha256: "", record_locator: `csv row ${rowNo}` }, review_status: "needs_review", review_reasons: [...(parsedAmount === null ? ["Amount is blank or unknown in source."] : []), ...(reason ? [reason] : [])] });
  };
  rows.forEach((row, index) => {
    const rowNo = index + 1; const cells = row.map(clean); const first = cells[0] ?? "";
    if (cells.every((v) => !v)) { skippedRows++; return; }
    if (/^REAL ASSETS$/i.test(first)) { section = "real"; financialHeader = false; return; }
    if (/^CASH FLOW$/i.test(first)) { section = "cash"; financialHeader = false; return; }
    if (/^MONTHLY SURPLUS/i.test(first)) { section = "surplus"; financialHeader = false; return; }
    if (/^LIABILITIES$/i.test(first)) { section = "liability"; financialHeader = false; return; }
    if (/^FINANCIAL ASSETS/i.test(first)) { section = "financial"; financialHeader = false; return; }
    if (/^Current Asset allocation$/i.test(first) || /^total net worth$/i.test(cells[2] ?? "")) { section = "ignore"; return; }
    if (section === "real" && first !== "Particulars") {
      if (first === "Vehicle" || first === "Jewelry" || first === "Other Assets" || first === "Property") push("asset", "real_asset", nonempty(cells[1]) ?? nonempty(first), nonempty(cells[5]), cells[2] ?? "", rowNo, null, "Real-asset value is a point-in-time estimate.");
      else if (cells[1]) push("asset", "real_asset", cells[1], nonempty(cells[5]), cells[2] ?? "", rowNo, null, "Real-asset value is a point-in-time estimate.");
      return;
    }
    if (section === "cash" && first !== "Monthly component" && first !== "Yearly component" && first !== "") {
      push("cash_flow", "monthly_expense", first, "Self", cells[1] ?? "", rowNo);
      if (cells[3]) { push("cash_flow", "yearly_expense", cells[3], "Self", cells[4] ?? "", rowNo); push("cash_flow", "yearly_expense", cells[3], "Spouse", cells[5] ?? "", rowNo); }
      return;
    }
    if (section === "surplus" && first && first !== "Income") {
      const value = /^\d+(?:\.\d+)?%$/.test(cells[1] ?? "") ? (cells[2] ?? "") : (cells[1] === "" ? cells[2] ?? "" : cells[1]);
      push("cash_flow", "surplus", first, null, value, rowNo);
      return;
    }
    if (section === "surplus" && first === "Income") { push("cash_flow", "income", first, null, cells[1] ?? "", rowNo); return; }
    if (section === "surplus" && first === "") { if (cells[2]) push("cash_flow", "surplus", null, null, cells[2], rowNo); return; }
    if (section === "liability" && first !== "Particulars") { push("liability", "loan", nonempty(first), null, cells[1] ?? "", rowNo, null, "Balance term and rate are retained only as source context."); return; }
    if (section === "financial") {
      if (first === "Particulars") { financialHeader = true; return; }
      if (!financialHeader || first === "Total") return;
      if (/^(Home Loan 2|Vehicle Loan|Educational Loan|Personal Loan)$/i.test(first)) { push("liability", "loan", first, null, cells[1] ?? "", rowNo); return; }
      push("asset", cells[6] || "financial_asset", first, nonempty(cells[1]), cells[3] ?? "", rowNo, nonempty(cells[1]), "Financial-asset value is a point-in-time snapshot.");
    }
  });
  return { rows: records, readRows: rows.length, skippedRows, errors, asOfDate };
}

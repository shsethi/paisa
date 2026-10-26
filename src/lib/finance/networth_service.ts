/**
 * Net-worth calculation over normalized holding and manual-balance records.
 *
 * Formula (per currency): net worth = included assets - included liabilities.
 * Values are selected as-of the requested date. Holdings without an as-of date
 * are not valued. For each manual import, only its latest snapshot on or before
 * the requested date is used. Records in an unresolved overlap group are kept
 * in `overlaps` and excluded from all totals, preventing double counting.
 */

const SCALE = 6n;
const UNIT = 10n ** SCALE;

export type NetWorthSource = {
  import_id: string;
  original_path: string;
  record_locator: string;
  content_sha256?: string;
};

export type NetWorthHolding = {
  record_type: "holding";
  source_id: string;
  current_value: string;
  currency: string;
  as_of_date: string | null;
  source: NetWorthSource;
  /** Optional stable key supplied when an account/security is known to overlap. */
  overlap_key?: string;
  security?: { name?: string; identifier?: string; symbol?: string };
};

export type NetWorthManualBalance = {
  record_type: "manual_balance";
  source_id: string;
  balance_type: "asset" | "liability" | "cash_flow";
  amount: string | null;
  currency: string | null;
  as_of_date: string;
  source: NetWorthSource;
  overlap_key?: string;
  category?: string;
  label?: string | null;
  owner?: string | null;
  account_label?: string | null;
};

export type NetWorthInput = {
  asOfDate: string;
  holdings?: NetWorthHolding[];
  manualBalances?: NetWorthManualBalance[];
};

export type NetWorthLine = {
  source_id: string;
  kind: "holding" | "manual_balance";
  currency: string;
  amount: string;
  as_of_date: string;
  source: NetWorthSource;
  label?: string | null;
};

export type NetWorthOverlap = {
  key: string;
  reason: "duplicate_or_overlapping_records";
  record_ids: string[];
  records: NetWorthLine[];
};

export type NetWorthCurrencyTotals = {
  assets: string;
  liabilities: string;
  netWorth: string;
  assetRecordIds: string[];
  liabilityRecordIds: string[];
};

export type NetWorthResult = {
  asOfDate: string;
  currencies: Record<string, NetWorthCurrencyTotals>;
  assets: NetWorthLine[];
  liabilities: NetWorthLine[];
  overlaps: NetWorthOverlap[];
  excludedRecords: Array<{ source_id: string; reason: "missing_as_of_date" | "invalid_as_of_date" | "after_selected_date" | "missing_amount" | "missing_currency" | "cash_flow_record" | "superseded_overlap" | "unresolved_overlap" }>;
  excludedRecordIds: string[];
};

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

function money(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim().replaceAll(",", ""));
  if (!match) throw new Error(`Invalid monetary value: ${value}`);
  const fraction = match[3] ?? "";
  const truncated = fraction.slice(0, Number(SCALE)).padEnd(Number(SCALE), "0");
  const rounded = BigInt(truncated) + (fraction[Number(SCALE)] && fraction[Number(SCALE)] >= "5" ? 1n : 0n);
  const absolute = BigInt(match[2]) * UNIT + rounded;
  return match[1] === "-" ? -absolute : absolute;
}

function formatMoney(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / UNIT;
  const fraction = (absolute % UNIT).toString().padStart(Number(SCALE), "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function overlapKey(record: NetWorthHolding | NetWorthManualBalance): string {
  if (record.record_type === "manual_balance") {
    if (/\bmeesho\b/i.test(record.label ?? "")) return "holding:meesho";
    const label = [record.balance_type, record.category, record.label, record.owner, record.account_label].map((v) => String(v ?? "").trim().toLowerCase()).join("|");
    return `manual:${label || record.source_id}`;
  }
  const security = record.security ?? {};
  if (/\bmeesho\b/i.test(security.name ?? "") && money(record.current_value) !== 0n) return "holding:meesho";
  const identifier = String(security.identifier ?? "").trim();
  const folio = (identifier.includes(":") ? identifier.slice(identifier.lastIndexOf(":") + 1) : identifier).split("/", 1)[0];
  if (/^\d{5,}$/.test(folio)) return `holding:folio:${folio}`;
  if (record.overlap_key?.trim()) return record.overlap_key.trim();
  return `holding:${security.identifier ?? security.symbol ?? security.name ?? record.source_id}`.toLowerCase();
}

function line(record: NetWorthHolding | NetWorthManualBalance, amount: string, date: string): NetWorthLine {
  return {
    source_id: record.source_id,
    kind: record.record_type,
    currency: record.currency ?? "",
    amount,
    as_of_date: date,
    source: record.source,
    ...(record.record_type === "manual_balance" ? { label: record.label } : {})
  };
}

export function calculateNetWorth(input: NetWorthInput): NetWorthResult {
  if (!validDate(input.asOfDate)) throw new Error("asOfDate must be an ISO date (YYYY-MM-DD).");
  const holdings = input.holdings ?? [];
  const manual = input.manualBalances ?? [];
  const selected: Array<{ record: NetWorthHolding | NetWorthManualBalance; date: string }> = [];
  const excludedRecords: NetWorthResult["excludedRecords"] = [];

  // A holding export is a point-in-time report; use only dated reports at or
  // before the requested date. Missing dates are intentionally unresolved.
  for (const record of holdings) {
    if (!record.as_of_date) { excludedRecords.push({ source_id: record.source_id, reason: "missing_as_of_date" }); continue; }
    if (!validDate(record.as_of_date)) { excludedRecords.push({ source_id: record.source_id, reason: "invalid_as_of_date" }); continue; }
    if (record.as_of_date > input.asOfDate) { excludedRecords.push({ source_id: record.source_id, reason: "after_selected_date" }); continue; }
    if (!record.currency) { excludedRecords.push({ source_id: record.source_id, reason: "missing_currency" }); continue; }
    {
      money(record.current_value);
      selected.push({ record, date: record.as_of_date });
    }
  }

  // Manual balances are snapshots. For the same labeled asset/liability, use
  // the newest source snapshot at or before the requested date, even when each
  // snapshot came from a different import file.
  const byBalance = new Map<string, NetWorthManualBalance[]>();
  for (const record of manual) {
    if (record.balance_type === "cash_flow") { excludedRecords.push({ source_id: record.source_id, reason: "cash_flow_record" }); continue; }
    if (!record.amount) { excludedRecords.push({ source_id: record.source_id, reason: "missing_amount" }); continue; }
    if (!record.currency) { excludedRecords.push({ source_id: record.source_id, reason: "missing_currency" }); continue; }
    if (!validDate(record.as_of_date)) { excludedRecords.push({ source_id: record.source_id, reason: "invalid_as_of_date" }); continue; }
    if (record.as_of_date > input.asOfDate) { excludedRecords.push({ source_id: record.source_id, reason: "after_selected_date" }); continue; }
    money(record.amount);
    const key = overlapKey(record);
    const rows = byBalance.get(key) ?? [];
    rows.push(record);
    byBalance.set(key, rows);
  }
  for (const rows of byBalance.values()) {
    const latest = rows.reduce((date, row) => row.as_of_date > date ? row.as_of_date : date, "0000-00-00");
    for (const record of rows.filter((row) => row.as_of_date === latest)) selected.push({ record, date: latest });
  }

  const groups = new Map<string, typeof selected>();
  for (const item of selected) {
    const key = `${item.record.currency ?? ""}|${overlapKey(item.record)}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const included: typeof selected = [];
  const overlaps: NetWorthOverlap[] = [];
  for (const [key, group] of groups) {
    const distinct = new Set(group.map(({ record }) => record.source_id));
    if (distinct.size > 1) {
      const latest = group.reduce((date, item) => item.date > date ? item.date : date, "0000-00-00");
      const latestGroup = group.filter((item) => item.date === latest);
      const latestDistinct = new Set(latestGroup.map(({ record }) => record.source_id));
      if (latestDistinct.size === 1) {
        included.push(...latestGroup);
        excludedRecords.push(...group.filter((item) => item.date < latest).map(({ record }) => ({ source_id: record.source_id, reason: "superseded_overlap" as const })));
      } else {
        const records = latestGroup.map(({ record, date }) => line(record, record.record_type === "holding" ? record.current_value : record.amount!, date));
        overlaps.push({ key, reason: "duplicate_or_overlapping_records", record_ids: records.map((record) => record.source_id), records });
      }
    } else included.push(...group);
  }

  const assets: NetWorthLine[] = [], liabilities: NetWorthLine[] = [];
  for (const { record, date } of included) {
    const value = record.record_type === "holding" ? record.current_value : record.amount!;
    const output = line(record, value, date);
    if (record.record_type === "manual_balance" && record.balance_type === "liability") liabilities.push(output);
    else assets.push(output);
  }
  const currencies: Record<string, NetWorthCurrencyTotals> = {};
  for (const output of [...assets, ...liabilities]) {
    const totals = currencies[output.currency] ?? { assets: "0", liabilities: "0", netWorth: "0", assetRecordIds: [], liabilityRecordIds: [] };
    const amount = money(output.amount);
    if (liabilities.includes(output)) { totals.liabilities = formatMoney(money(totals.liabilities) + amount); totals.liabilityRecordIds.push(output.source_id); }
    else { totals.assets = formatMoney(money(totals.assets) + amount); totals.assetRecordIds.push(output.source_id); }
    totals.netWorth = formatMoney(money(totals.assets) - money(totals.liabilities));
    currencies[output.currency] = totals;
  }
  excludedRecords.push(...overlaps.flatMap((overlap) => overlap.record_ids.map((source_id) => ({ source_id, reason: "unresolved_overlap" as const }))));
  return { asOfDate: input.asOfDate, currencies, assets, liabilities, overlaps, excludedRecords, excludedRecordIds: [...new Set([...overlaps.flatMap((overlap) => overlap.record_ids), ...excludedRecords.map((record) => record.source_id)])] };
}


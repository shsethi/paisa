import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { loadLatestZerodhaKiteSnapshot } from "./zerodha_kite_snapshot";

type Manifest = {
  import_id: string;
  source_type: string;
  original_path: string;
  content_sha256: string;
  imported_at: string;
  status: string;
};
export type BankTransaction = {
  debit?: string | null;
  credit?: string | null;
  balance?: string | null;
  currency?: string;
  source?: { original_path?: string };
};
export type HoldingRecord = {
  current_value?: string;
  currency?: string;
  overlap_key?: string;
  security?: {
    identifier?: string;
    isin?: string;
    symbol?: string;
    name?: string;
    category?: string;
  };
  source?: { original_path?: string; record_locator?: string };
};
export type ManualBalance = { amount?: string | null; currency?: string; balance_type?: string };
export type TaxRecord = {
  source: "itr" | "ais" | "form16" | "form26as" | "annual_tax_statement";
  financial_year: string;
};

export type FinanceReconciliationInput = {
  bankStatements: Array<{ source: string; transactions: BankTransaction[] }>;
  holdings: HoldingRecord[];
  balances: ManualBalance[];
  taxRecords: TaxRecord[];
  issues?: string[];
  generatedAt?: Date;
};

export type FinanceReconciliationReport = {
  generated_at: string;
  status: "ok" | "warning" | "error";
  bank_balances: Array<{
    source: string;
    currency: string;
    transaction_count: number;
    direction: "ascending" | "descending" | "unknown";
    opening_balance: string | null;
    closing_balance: string | null;
    mismatch_count: number;
    status: "ok" | "warning" | "error";
  }>;
  duplicate_holdings: Array<{ key: string; occurrences: number; sources: string[] }>;
  portfolio_totals: Array<{
    currency: string;
    holdings: string;
    assets: string;
    liabilities: string;
    net: string;
    invalid_records: number;
  }>;
  tax_year_completeness: Array<{
    financial_year: string;
    sources_present: TaxRecord["source"][];
    missing_required: Array<"itr" | "ais" | "tax_statement">;
    status: "complete" | "incomplete";
  }>;
  issues: string[];
};

const amount = (value: unknown): number | null => {
  const text = String(value ?? "")
    .trim()
    .replaceAll(",", "");
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
};
const money = (value: number) => value.toFixed(2);
const delta = (row: BankTransaction) => (amount(row.credit) ?? 0) - (amount(row.debit) ?? 0);
const mismatch = (actual: number, expected: number) => Math.abs(actual - expected) > 0.011;

function reconcileBank(
  source: string,
  transactions: BankTransaction[]
): FinanceReconciliationReport["bank_balances"][number] {
  const rows = transactions.filter((row) => amount(row.balance) !== null);
  const currency = rows.find((row) => row.currency)?.currency ?? "INR";
  if (rows.length === 0)
    return {
      source,
      currency,
      transaction_count: transactions.length,
      direction: "unknown",
      opening_balance: null,
      closing_balance: null,
      mismatch_count: 0,
      status: "warning"
    };
  let ascendingMismatch = 0;
  let descendingMismatch = 0;
  for (let index = 1; index < rows.length; index++) {
    const previous = amount(rows[index - 1].balance)!;
    const current = amount(rows[index].balance)!;
    if (mismatch(current, previous + delta(rows[index]))) ascendingMismatch++;
    if (mismatch(previous, current + delta(rows[index - 1]))) descendingMismatch++;
  }
  const ascending = ascendingMismatch <= descendingMismatch;
  const mismatches = ascending ? ascendingMismatch : descendingMismatch;
  const first = rows[0];
  const last = rows.at(-1)!;
  const opening = ascending
    ? amount(first.balance)! - delta(first)
    : amount(last.balance)! - delta(last);
  const closing = ascending ? amount(last.balance)! : amount(first.balance)!;
  return {
    source,
    currency,
    transaction_count: transactions.length,
    direction: rows.length < 2 ? "unknown" : ascending ? "ascending" : "descending",
    opening_balance: money(opening),
    closing_balance: money(closing),
    mismatch_count: mismatches,
    status: rows.length !== transactions.length ? "warning" : mismatches ? "error" : "ok"
  };
}

const holdingKey = (row: HoldingRecord): string | null => {
  const security = row.security ?? {};
  const raw =
    row.overlap_key ?? security.identifier ?? security.isin ?? security.symbol ?? security.name;
  const key = String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return key || null;
};

export function buildFinanceReconciliation(
  input: FinanceReconciliationInput
): FinanceReconciliationReport {
  const bankBalances = input.bankStatements.map((statement) =>
    reconcileBank(statement.source, statement.transactions)
  );
  const groupedHoldings = new Map<string, HoldingRecord[]>();
  for (const holding of input.holdings) {
    const key = holdingKey(holding);
    if (key) groupedHoldings.set(key, [...(groupedHoldings.get(key) ?? []), holding]);
  }
  const duplicateHoldings = [...groupedHoldings.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => ({
      key,
      occurrences: rows.length,
      sources: [...new Set(rows.map((row) => row.source?.original_path ?? "unknown"))].sort()
    }))
    .sort((left, right) => left.key.localeCompare(right.key));

  const currencies = new Map<
    string,
    { holdings: number; assets: number; liabilities: number; invalid: number }
  >();
  const totals = (currency: string) => {
    const key = currency || "UNKNOWN";
    const current = currencies.get(key) ?? { holdings: 0, assets: 0, liabilities: 0, invalid: 0 };
    currencies.set(key, current);
    return current;
  };
  for (const holding of input.holdings) {
    const current = totals(holding.currency ?? "UNKNOWN");
    const value = amount(holding.current_value);
    if (value === null) current.invalid++;
    else current.holdings += value;
  }
  for (const balance of input.balances) {
    if (balance.balance_type === "cash_flow") continue;
    const current = totals(balance.currency ?? "UNKNOWN");
    const value = amount(balance.amount);
    if (value === null) current.invalid++;
    else if (balance.balance_type === "liability") current.liabilities += Math.abs(value);
    else current.assets += value;
  }
  const portfolioTotals = [...currencies.entries()]
    .map(([currency, value]) => ({
      currency,
      holdings: money(value.holdings),
      assets: money(value.assets),
      liabilities: money(value.liabilities),
      net: money(value.holdings + value.assets - value.liabilities),
      invalid_records: value.invalid
    }))
    .sort((left, right) => left.currency.localeCompare(right.currency));

  const taxYears = new Map<string, Set<TaxRecord["source"]>>();
  for (const record of input.taxRecords)
    if (record.financial_year)
      taxYears.set(
        record.financial_year,
        (taxYears.get(record.financial_year) ?? new Set()).add(record.source)
      );
  const taxYearCompleteness = [...taxYears.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([financialYear, sourceSet]) => {
      const sources = [...sourceSet].sort() as TaxRecord["source"][];
      const missing: Array<"itr" | "ais" | "tax_statement"> = [];
      if (!sourceSet.has("itr")) missing.push("itr");
      if (!sourceSet.has("ais")) missing.push("ais");
      if (!sourceSet.has("form26as") && !sourceSet.has("annual_tax_statement"))
        missing.push("tax_statement");
      return {
        financial_year: financialYear,
        sources_present: sources,
        missing_required: missing,
        status: missing.length ? ("incomplete" as const) : ("complete" as const)
      };
    });

  const issues = [...(input.issues ?? [])];
  if (duplicateHoldings.length)
    issues.push(`${duplicateHoldings.length} holding identifier(s) appear more than once.`);
  if (portfolioTotals.some((total) => total.invalid_records))
    issues.push("Some portfolio records contain invalid amounts.");
  if (taxYearCompleteness.some((year) => year.status === "incomplete"))
    issues.push("One or more tax years are missing a required source family.");
  const hasError =
    bankBalances.some((bank) => bank.status === "error") ||
    portfolioTotals.some((total) => total.invalid_records > 0);
  return {
    generated_at: (input.generatedAt ?? new Date()).toISOString(),
    status: hasError
      ? "error"
      : issues.length || bankBalances.some((bank) => bank.status === "warning")
        ? "warning"
        : "ok",
    bank_balances: bankBalances,
    duplicate_holdings: duplicateHoldings,
    portfolio_totals: portfolioTotals,
    tax_year_completeness: taxYearCompleteness,
    issues
  };
}

const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");

function latestArtifacts<T>(
  root: string,
  sourceType: string,
  dataFile: string,
  issues: string[]
): Array<{ manifest: Manifest; data: T }> {
  const directory = path.join(root, "extracted", "imports", sourceType);
  if (!existsSync(directory)) return [];
  const latest = new Map<string, { manifest: Manifest; dataPath: string }>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(
        readFileSync(path.join(directory, entry.name, "manifest.json"), "utf8")
      ) as Manifest;
      if (
        !["succeeded", "succeeded_with_errors"].includes(manifest.status) ||
        manifest.import_id !== entry.name
      )
        continue;
      const previous = latest.get(manifest.original_path);
      if (!previous || manifest.imported_at > previous.manifest.imported_at)
        latest.set(manifest.original_path, {
          manifest,
          dataPath: path.join(directory, entry.name, dataFile)
        });
    } catch {
      issues.push(`Could not read a ${sourceType} manifest.`);
    }
  }
  const output: Array<{ manifest: Manifest; data: T }> = [];
  for (const item of latest.values()) {
    try {
      const original = path.join(root, "imports", ...item.manifest.original_path.split("/"));
      if (
        !statSync(original).isFile() ||
        sha256(readFileSync(original)) !== item.manifest.content_sha256
      ) {
        issues.push(`Stale source: ${item.manifest.original_path}`);
        continue;
      }
      output.push({
        manifest: item.manifest,
        data: JSON.parse(readFileSync(item.dataPath, "utf8")) as T
      });
    } catch {
      issues.push(`Could not reconcile ${item.manifest.original_path}.`);
    }
  }
  return output;
}

function yearFrom(record: any): string | null {
  return record?.identity?.financialYear?.value ?? record?.financial_year ?? null;
}

export function reconcileFinanceRoot(
  rootOption: string,
  generatedAt?: Date
): FinanceReconciliationReport {
  const root = path.resolve(rootOption);
  if (!existsSync(path.join(root, "imports")))
    throw new Error("Finance root does not contain an imports folder.");
  const issues: string[] = [];
  const bankStatements = ["icici", "federal"].flatMap((sourceType) =>
    latestArtifacts<BankTransaction[]>(root, sourceType, "transactions.json", issues).map(
      ({ manifest, data }) => ({ source: manifest.original_path, transactions: data })
    )
  );
  const holdings = ["kuvera_holdings", "indmoney_holdings", "nsdl_cas_holdings"].flatMap(
    (sourceType) =>
      latestArtifacts<HoldingRecord[]>(root, sourceType, "holdings.json", issues).flatMap(
        ({ data }) => data
      )
  );
  const kite = loadLatestZerodhaKiteSnapshot(root, issues);
  if (kite) holdings.push(...kite.holdings);
  const balances = latestArtifacts<ManualBalance[]>(
    root,
    "manual_balances",
    "balances.json",
    issues
  ).flatMap(({ data }) => data);
  const taxRecords: TaxRecord[] = [];
  for (const { data } of latestArtifacts<any>(root, "itr_returns", "return.json", issues)) {
    const year = yearFrom(data);
    if (year) taxRecords.push({ source: "itr", financial_year: year });
  }
  for (const { data } of latestArtifacts<any>(root, "ais_json", "facts.json", issues)) {
    const year = yearFrom(data);
    if (year) taxRecords.push({ source: "ais", financial_year: year });
  }
  for (const { data } of latestArtifacts<any[]>(
    root,
    "annual_tax_statement",
    "records.json",
    issues
  ))
    for (const record of data) {
      const year = yearFrom(record);
      if (year) taxRecords.push({ source: "annual_tax_statement", financial_year: year });
    }
  for (const sourceType of ["form16", "form26as"] as const)
    for (const { data } of latestArtifacts<any>(root, sourceType, "summary.json", issues)) {
      const year = yearFrom(data);
      if (year) taxRecords.push({ source: sourceType, financial_year: year });
    }
  return buildFinanceReconciliation({
    bankStatements,
    holdings,
    balances,
    taxRecords,
    issues,
    generatedAt
  });
}

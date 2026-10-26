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

type ImportedRow = {
  source_id?: string;
  source?: {
    import_id?: string;
    original_path?: string;
    content_sha256?: string;
  };
  [key: string]: unknown;
};

export type AuditHolding = {
  key: string;
  name: string;
  units: number;
  currency: string;
  platform: string;
};

export type AuditTrade = {
  key: string;
  name: string;
  side: "buy" | "sell";
  quantity: number;
  currency: string;
  platform: string;
};

export type InvestmentHistoryClassification =
  | "reliable_xirr"
  | "current_value_only"
  | "realized_return_only"
  | "invalid";

export type InvestmentHistoryAuditReport = {
  generated_at: string;
  status: "ok" | "warning" | "error";
  summary: {
    total: number;
    reliable_xirr: number;
    current_value_only: number;
    realized_return_only: number;
    invalid: number;
  };
  investments: Array<{
    key: string;
    name: string;
    platforms: string[];
    currencies: string[];
    current_units: string | null;
    transaction_units: string;
    residual_units: string | null;
    buy_count: number;
    sell_count: number;
    classification: InvestmentHistoryClassification;
    reasons: string[];
  }>;
  issues: string[];
};

export type InvestmentHistoryAuditInput = {
  holdings: AuditHolding[];
  trades: AuditTrade[];
  issues?: string[];
  generatedAt?: Date;
};

const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const clean = (value: unknown) => String(value ?? "").trim();
const number = (value: unknown): number | null => {
  const result = Number(clean(value).replaceAll(",", ""));
  return Number.isFinite(result) ? result : null;
};
const decimal = (value: number): string =>
  (Math.abs(value) < 1e-10 ? 0 : value).toFixed(8).replace(/\.?0+$/, "") || "0";
const keyPart = (value: unknown) =>
  clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
const fundNameKey = (value: unknown): string =>
  clean(value)
    .toLowerCase()
    .replace(/\b(fund|growth|direct|plan|option)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");

function stableKey(value: {
  identifier?: unknown;
  isin?: unknown;
  symbol?: unknown;
  name?: unknown;
}): string | null {
  const isin = keyPart(value.isin);
  if (isin) return `security:${isin}`;
  const identifier = clean(value.identifier);
  if (/^\d{5,}(?:\/\d+)?$/.test(identifier)) return `folio:${identifier.split("/", 1)[0]}`;
  if (identifier) return `security:${keyPart(identifier)}`;
  const symbol = keyPart(value.symbol);
  if (symbol) return `symbol:${symbol}`;
  const name = fundNameKey(value.name);
  return name ? `name:${name}` : null;
}

function tolerance(current: number): number {
  return Math.max(1e-6, Math.abs(current) * 1e-8);
}

export function buildInvestmentHistoryAudit(
  input: InvestmentHistoryAuditInput
): InvestmentHistoryAuditReport {
  const grouped = new Map<string, { holdings: AuditHolding[]; trades: AuditTrade[] }>();
  const group = (key: string) => {
    const value = grouped.get(key) ?? { holdings: [], trades: [] };
    grouped.set(key, value);
    return value;
  };
  for (const holding of input.holdings) group(holding.key).holdings.push(holding);
  for (const trade of input.trades) group(trade.key).trades.push(trade);

  const investments = [...grouped.entries()].map(([key, rows]) => {
    const currentUnits = rows.holdings.length
      ? rows.holdings.reduce((sum, row) => sum + row.units, 0)
      : null;
    const bought = rows.trades
      .filter((row) => row.side === "buy")
      .reduce((sum, row) => sum + row.quantity, 0);
    const sold = rows.trades
      .filter((row) => row.side === "sell")
      .reduce((sum, row) => sum + row.quantity, 0);
    const transactionUnits = bought - sold;
    const residual = currentUnits === null ? null : currentUnits - transactionUnits;
    const currencies = [
      ...new Set([...rows.holdings, ...rows.trades].map((row) => row.currency).filter(Boolean))
    ].sort();
    const reasons: string[] = [];
    let classification: InvestmentHistoryClassification;

    if (currencies.length > 1) reasons.push("currency_mismatch");
    if (transactionUnits < -1e-6) reasons.push("negative_transaction_units");
    if (currentUnits === null) {
      if (Math.abs(transactionUnits) <= 1e-6 && bought > 0 && sold > 0) {
        classification = currencies.length > 1 ? "invalid" : "realized_return_only";
      } else {
        classification = "invalid";
        reasons.push("current_holding_missing");
      }
    } else if (rows.trades.length === 0) {
      classification = "current_value_only";
      reasons.push("no_transaction_history");
    } else if (residual !== null && Math.abs(residual) > tolerance(currentUnits)) {
      classification = transactionUnits < -1e-6 ? "invalid" : "current_value_only";
      reasons.push("unit_mismatch");
    } else if (currencies.length > 1) {
      classification = "invalid";
    } else {
      classification = "reliable_xirr";
    }

    const names = [...rows.holdings, ...rows.trades].map((row) => row.name).filter(Boolean);
    return {
      key,
      name: names[0] ?? key,
      platforms: [...new Set([...rows.holdings, ...rows.trades].map((row) => row.platform))].sort(),
      currencies,
      current_units: currentUnits === null ? null : decimal(currentUnits),
      transaction_units: decimal(transactionUnits),
      residual_units: residual === null ? null : decimal(residual),
      buy_count: rows.trades.filter((row) => row.side === "buy").length,
      sell_count: rows.trades.filter((row) => row.side === "sell").length,
      classification,
      reasons: [...new Set(reasons)].sort()
    };
  });
  investments.sort(
    (left, right) =>
      left.classification.localeCompare(right.classification) || left.name.localeCompare(right.name)
  );
  const summary = {
    total: investments.length,
    reliable_xirr: investments.filter((row) => row.classification === "reliable_xirr").length,
    current_value_only: investments.filter((row) => row.classification === "current_value_only")
      .length,
    realized_return_only: investments.filter((row) => row.classification === "realized_return_only")
      .length,
    invalid: investments.filter((row) => row.classification === "invalid").length
  };
  const issues = [...(input.issues ?? [])];
  if (summary.current_value_only)
    issues.push(
      `${summary.current_value_only} current investment(s) lack complete transaction history.`
    );
  if (summary.invalid)
    issues.push(`${summary.invalid} investment history record(s) are internally inconsistent.`);
  return {
    generated_at: (input.generatedAt ?? new Date()).toISOString(),
    status: summary.invalid ? "error" : issues.length ? "warning" : "ok",
    summary,
    investments,
    issues
  };
}

function latestArtifacts(
  root: string,
  sourceType: string,
  dataFile: string,
  issues: string[]
): Array<{ manifest: Manifest; rows: ImportedRow[] }> {
  const directory = path.join(root, "extracted", "imports", sourceType);
  if (!existsSync(directory)) return [];
  const latest = new Map<string, Manifest>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(
        readFileSync(path.join(directory, entry.name, "manifest.json"), "utf8")
      ) as Manifest;
      if (
        !["succeeded", "succeeded_with_errors"].includes(manifest.status) ||
        manifest.import_id !== entry.name ||
        manifest.source_type !== sourceType
      )
        continue;
      const previous = latest.get(manifest.original_path);
      if (!previous || manifest.imported_at > previous.imported_at)
        latest.set(manifest.original_path, manifest);
    } catch {
      issues.push(`Could not read a ${sourceType} manifest.`);
    }
  }
  const uniqueContent = new Map<string, Manifest>();
  for (const manifest of latest.values()) {
    const previous = uniqueContent.get(manifest.content_sha256);
    if (!previous || manifest.original_path.localeCompare(previous.original_path) < 0)
      uniqueContent.set(manifest.content_sha256, manifest);
  }
  const result: Array<{ manifest: Manifest; rows: ImportedRow[] }> = [];
  for (const manifest of uniqueContent.values()) {
    try {
      const original = path.join(root, "imports", ...manifest.original_path.split("/"));
      if (
        !statSync(original).isFile() ||
        sha256(readFileSync(original)) !== manifest.content_sha256
      ) {
        issues.push(`Stale source: ${manifest.original_path}`);
        continue;
      }
      const rows = JSON.parse(
        readFileSync(path.join(directory, manifest.import_id, dataFile), "utf8")
      ) as ImportedRow[];
      result.push({
        manifest,
        rows: rows.filter(
          (row) =>
            row.source?.import_id === manifest.import_id &&
            row.source?.original_path === manifest.original_path &&
            row.source?.content_sha256 === manifest.content_sha256
        )
      });
    } catch {
      issues.push(`Could not audit ${manifest.original_path}.`);
    }
  }
  return result;
}

function overlapKey(row: ImportedRow): string | null {
  const quantity = number(row.quantity);
  const price = number(row.price);
  const name = fundNameKey(row.instrument);
  if (!clean(row.trade_date) || quantity === null || price === null || !name) return null;
  return [
    clean(row.trade_date),
    clean(row.side).toLowerCase(),
    quantity.toString(),
    price.toString(),
    clean(row.currency).toUpperCase(),
    name
  ].join("|");
}

function indmoneyCurrency(row: ImportedRow): string {
  const original = (row.original_values ?? {}) as Record<string, unknown>;
  return Object.keys(original).some((key) => /\(\$\)|usd/i.test(key))
    ? "USD"
    : clean(row.currency).toUpperCase();
}

export function auditInvestmentHistoryRoot(
  rootOption: string,
  generatedAt?: Date
): InvestmentHistoryAuditReport {
  const root = path.resolve(rootOption);
  if (!existsSync(path.join(root, "imports")))
    throw new Error("Finance root does not contain an imports folder.");
  const issues: string[] = [];
  const holdings: AuditHolding[] = [];
  const trades: AuditTrade[] = [];
  const holdingKeysByName = new Map<string, string | null>();
  const addHolding = (holding: AuditHolding) => {
    holdings.push(holding);
    const name = fundNameKey(holding.name);
    if (!name) return;
    const previous = holdingKeysByName.get(name);
    holdingKeysByName.set(
      name,
      previous === undefined || previous === holding.key ? holding.key : null
    );
  };

  for (const sourceType of ["kuvera_holdings", "indmoney_holdings"] as const) {
    for (const { rows } of latestArtifacts(root, sourceType, "holdings.json", issues)) {
      for (const row of rows) {
        const security = (row.security ?? {}) as Record<string, unknown>;
        const key = stableKey(security);
        const units = number(row.units);
        if (!key || units === null) {
          issues.push(`An invalid ${sourceType} holding was ignored.`);
          continue;
        }
        addHolding({
          key,
          name: clean(security.name ?? security.symbol ?? security.identifier) || key,
          units,
          currency: clean(row.currency).toUpperCase(),
          platform: sourceType === "kuvera_holdings" ? "Kuvera" : "INDmoney"
        });
      }
    }
  }
  const kite = loadLatestZerodhaKiteSnapshot(root, issues);
  for (const row of kite?.holdings ?? []) {
    const key = stableKey(row.security ?? {});
    const units = number(row.units);
    if (!key || units === null) {
      issues.push("An invalid Kite holding was ignored.");
      continue;
    }
    addHolding({
      key,
      name: clean(row.security?.name ?? row.security?.symbol) || key,
      units,
      currency: clean(row.currency).toUpperCase(),
      platform: "Kite"
    });
  }

  const sourceSpecs = [
    ["zerodha_tradebook", "trades.json", "Kite"],
    ["kuvera_transactions", "transactions.json", "Kuvera"],
    ["manual_investment_trades", "trades.json", "Manual"],
    ["indmoney_orders", "orders.json", "INDmoney"]
  ] as const;
  const importedTrades: Array<ImportedRow & { source_type: string; platform: string }> = [];
  for (const [sourceType, dataFile, platform] of sourceSpecs)
    for (const { rows } of latestArtifacts(root, sourceType, dataFile, issues))
      importedTrades.push(...rows.map((row) => ({ ...row, source_type: sourceType, platform })));

  const preferredOverlapSource = new Map<string, string>();
  const sourcePriority: Record<string, number> = {
    zerodha_tradebook: 0,
    manual_investment_trades: 1,
    kuvera_transactions: 2,
    indmoney_orders: 3
  };
  for (const row of importedTrades) {
    const key = overlapKey(row);
    if (!key) continue;
    const previous = preferredOverlapSource.get(key);
    if (previous === undefined || sourcePriority[row.source_type] < sourcePriority[previous])
      preferredOverlapSource.set(key, row.source_type);
  }
  for (const row of importedTrades) {
    const economicKey = overlapKey(row);
    if (economicKey && preferredOverlapSource.get(economicKey) !== row.source_type) continue;
    const side = clean(row.side ?? row.action).toLowerCase();
    if (side !== "buy" && side !== "sell") continue;
    const quantity = number(row.quantity);
    const identifierKey =
      row.source_type === "kuvera_transactions"
        ? stableKey({ identifier: row.folio, name: row.instrument })
        : row.source_type === "indmoney_orders"
          ? stableKey({
              symbol: ((row.original_values ?? {}) as Record<string, unknown>)["Stock Symbol"],
              name: row.instrument
            })
          : stableKey({ isin: row.isin, symbol: row.instrument, name: row.instrument });
    const matchedHoldingKey = holdingKeysByName.get(fundNameKey(row.instrument));
    const key = matchedHoldingKey ?? identifierKey;
    if (!key || quantity === null || quantity <= 0) {
      issues.push(`An invalid ${row.source_type} trade was ignored.`);
      continue;
    }
    trades.push({
      key,
      name: clean(row.instrument) || key,
      side,
      quantity,
      currency:
        row.source_type === "indmoney_orders"
          ? indmoneyCurrency(row)
          : clean(row.currency).toUpperCase(),
      platform: row.platform
    });
  }

  return buildInvestmentHistoryAudit({ holdings, trades, issues, generatedAt });
}

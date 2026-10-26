import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

type Source = {
  import_id: string;
  original_path: string;
  content_sha256: string;
  record_locator: string;
};
type Record = {
  record_type: "holding" | "manual_balance";
  source_id: string;
  current_value?: string;
  units?: string;
  currency?: string;
  as_of_date?: string | null;
  balance_type?: "asset" | "liability" | "cash_flow";
  amount?: string | null;
  category?: string;
  label?: string | null;
  security?: { name?: string; identifier?: string; symbol?: string; category?: string };
  source: Source;
  source_type?: string;
};
type Trade = {
  record_type: "zerodha_trade" | "kuvera_transaction" | "manual_investment_trade";
  source_id: string;
  trade_date: string;
  instrument: string;
  isin?: string;
  folio?: string;
  side: "buy" | "sell";
  quantity: string;
  price: string;
  currency: string;
  source: Source;
  source_type?: string;
};
type Manifest = {
  record_type: "import_manifest";
  import_id: string;
  source_type: string;
  original_path: string;
  content_sha256: string;
  imported_at: string;
  status: string;
};
type KiteSnapshotManifest = {
  record_type: "zerodha_kite_snapshot_manifest";
  fetched_at: string;
  as_of_date: string;
  source_type: "zerodha_kite_api";
  api_version: "3";
  content_sha256: string;
  counts: { holdings: number };
};
type KiteHolding = {
  tradingsymbol: string;
  exchange: string;
  isin?: string;
  quantity: number;
  average_price: number;
  last_price: number;
};
export type LedgerSnapshotExportOptions = {
  root: string;
  asOfDate?: string;
  output?: string;
  journal?: string;
  dryRun?: boolean;
};
export type LedgerSnapshotExportResult = {
  output: string;
  included: number;
  skipped: Array<{ source_id: string; reason: string }>;
  installed: boolean;
  dry_run: boolean;
};

const sources = [
  { name: "kuvera_holdings", data: "holdings.json" },
  { name: "indmoney_holdings", data: "holdings.json" },
  { name: "nsdl_cas_holdings", data: "holdings.json" },
  { name: "manual_balances", data: "balances.json" }
];
const tradeSources = [
  { name: "zerodha_tradebook", data: "trades.json" },
  { name: "kuvera_transactions", data: "transactions.json" },
  { name: "manual_investment_trades", data: "trades.json" }
];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const validDate = (value: string | undefined | null): value is string =>
  Boolean(
    value &&
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())
  );
const numeric = (value: string | undefined | null): string | null => {
  const output = value?.trim().replaceAll(",", "");
  return output && /^-?\d+(?:\.\d+)?$/.test(output) ? output : null;
};
const safePart = (value: string | undefined | null, fallback: string) =>
  String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || fallback;
const safeCommodity = (value: string | undefined | null, fallback: string) => {
  const commodity = safePart(value, fallback);
  return /^\d/.test(commodity) ? `SEC_${commodity}` : commodity;
};
const formatQuantity = (value: number): string =>
  value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") || "0";
const isMutualFund = (row: Record): boolean =>
  /mutual[_ ]?fund|\b(flexi|small|index|arbitrage|dynamic bond)\b/i.test(
    `${row.security?.category ?? ""} ${row.security?.name ?? ""}`
  );
const fundNameKey = (value: string | undefined): string =>
  String(value ?? "")
    .toLowerCase()
    .replace(/\b(fund|growth|direct|plan|option)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "") || "";
const reconciliationKey = (row: Record): string | null => {
  if (row.record_type === "manual_balance" && /\bmeesho\b/i.test(row.label ?? ""))
    return "holding:meesho";
  if (row.record_type !== "holding") return null;
  if (/\bmeesho\b/i.test(row.security?.name ?? "") && Number(row.current_value) !== 0)
    return "holding:meesho";
  if (!isMutualFund(row)) return null;
  const identifier = String(row.security?.identifier ?? "").trim();
  const folio = (
    identifier.includes(":") ? identifier.slice(identifier.lastIndexOf(":") + 1) : identifier
  ).split("/", 1)[0];
  return /^\d{5,}$/.test(folio) ? `holding:folio:${folio}` : null;
};
const assetClass = (category: string | undefined, holding: boolean): string => {
  const value = String(category ?? "")
    .trim()
    .toLowerCase();
  if (/\b(cash|bank|deposit)\b/.test(value)) return "Cash";
  if (/\b(debt|bond|fixed income)\b/.test(value)) return "Debt";
  if (/\breal[_ ]?asset|property\b/.test(value)) return "RealAssets";
  if (holding || /\b(equity|stock|fund|arbitrage|index|cap)\b/.test(value)) return "Equity";
  return "Other";
};

function atomicWrite(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      /* no temp file */
    }
    throw error;
  }
}

function readLatest(root: string): Record[] {
  const result: Record[] = [];
  for (const source of sources) {
    const directory = path.join(root, "extracted", "imports", source.name);
    if (!existsSync(directory)) continue;
    const latest = new Map<string, Manifest>();
    for (const entry of readdirSync(directory, { withFileTypes: true }).filter((item) =>
      item.isDirectory()
    )) {
      try {
        const manifest = JSON.parse(
          readFileSync(path.join(directory, entry.name, "manifest.json"), "utf8")
        ) as Manifest;
        if (
          manifest.record_type !== "import_manifest" ||
          manifest.source_type !== source.name ||
          manifest.import_id !== entry.name ||
          manifest.status === "failed"
        )
          continue;
        if (
          hash(`${manifest.source_type}\n${manifest.original_path}\n${manifest.content_sha256}`) !==
          manifest.import_id
        )
          continue;
        const prior = latest.get(manifest.original_path);
        if (!prior || manifest.imported_at > prior.imported_at)
          latest.set(manifest.original_path, manifest);
      } catch {
        /* malformed derived import is ignored */
      }
    }
    for (const manifest of latest.values()) {
      try {
        const rows = JSON.parse(
          readFileSync(path.join(directory, manifest.import_id, source.data), "utf8")
        ) as Record[];
        result.push(
          ...rows
            .filter(
              (row) =>
                row.source?.import_id === manifest.import_id &&
                row.source?.original_path === manifest.original_path &&
                row.source?.content_sha256 === manifest.content_sha256
            )
            .map((row) => ({ ...row, source_type: source.name }))
        );
      } catch {
        /* incomplete derived import is ignored */
      }
    }
  }
  result.push(...readLatestKiteHoldings(root));
  const newest = new Map<string, string>();
  for (const row of result) {
    const key = reconciliationKey(row);
    if (!key || !validDate(row.as_of_date)) continue;
    if ((newest.get(key) ?? "0000-00-00") < row.as_of_date) newest.set(key, row.as_of_date);
  }
  return result.filter((row) => {
    const key = reconciliationKey(row);
    return !key || !validDate(row.as_of_date) || row.as_of_date === newest.get(key);
  });
}

function readLatestKiteHoldings(root: string): Record[] {
  const base = path.join(root, "extracted", "api", "zerodha");
  if (!existsSync(base)) return [];
  let latest:
    | { manifest: KiteSnapshotManifest; holdings: KiteHolding[]; snapshotHash: string }
    | undefined;
  for (const dateEntry of readdirSync(base, { withFileTypes: true })) {
    if (!dateEntry.isDirectory() || !validDate(dateEntry.name)) continue;
    const datePath = path.join(base, dateEntry.name);
    for (const snapshotEntry of readdirSync(datePath, { withFileTypes: true })) {
      if (!snapshotEntry.isDirectory()) continue;
      try {
        const directory = path.join(datePath, snapshotEntry.name),
          manifest = JSON.parse(
            readFileSync(path.join(directory, "manifest.json"), "utf8")
          ) as KiteSnapshotManifest,
          snapshotBytes = readFileSync(path.join(directory, "snapshot.json")),
          snapshotHash = createHash("sha256").update(snapshotBytes).digest("hex"),
          snapshot = JSON.parse(snapshotBytes.toString("utf8")) as { holdings?: KiteHolding[] };
        if (
          manifest.record_type !== "zerodha_kite_snapshot_manifest" ||
          manifest.source_type !== "zerodha_kite_api" ||
          manifest.api_version !== "3" ||
          manifest.as_of_date !== dateEntry.name ||
          !validDate(manifest.as_of_date) ||
          Number.isNaN(new Date(manifest.fetched_at).getTime()) ||
          snapshotHash !== manifest.content_sha256 ||
          !Array.isArray(snapshot.holdings) ||
          snapshot.holdings.length !== manifest.counts?.holdings
        )
          continue;
        if (!latest || manifest.fetched_at > latest.manifest.fetched_at)
          latest = { manifest, holdings: snapshot.holdings, snapshotHash };
      } catch {
        /* invalid API snapshot is ignored */
      }
    }
  }
  if (!latest) return [];
  const seen = new Set<string>(),
    records: Record[] = [];
  for (const holding of latest.holdings) {
    const symbol = holding.tradingsymbol?.trim(),
      exchange = holding.exchange?.trim(),
      locator = `${exchange}:${symbol}`,
      units = Number(holding.quantity),
      lastPrice = Number(holding.last_price);
    if (
      !symbol ||
      !exchange ||
      seen.has(locator) ||
      !Number.isFinite(units) ||
      !Number.isFinite(lastPrice)
    )
      return [];
    seen.add(locator);
    const identifier = holding.isin?.trim() || locator,
      currentValue = formatQuantity(units * lastPrice),
      sourceId = hash(`zerodha_kite_api\n${latest.snapshotHash}\n${locator}`);
    records.push({
      record_type: "holding",
      source_id: sourceId,
      current_value: currentValue,
      units: formatQuantity(units),
      currency: "INR",
      as_of_date: latest.manifest.as_of_date,
      security: { name: symbol, symbol, identifier, category: "Equity" },
      source: {
        import_id: latest.snapshotHash,
        original_path: `api/zerodha/${latest.manifest.as_of_date}`,
        content_sha256: latest.snapshotHash,
        record_locator: locator
      },
      source_type: "zerodha_kite_api"
    });
  }
  return records;
}

function readLatestTrades(root: string): Trade[] {
  const result: Trade[] = [];
  for (const source of tradeSources) {
    const directory = path.join(root, "extracted", "imports", source.name);
    if (!existsSync(directory)) continue;
    const latest = new Map<string, Manifest>();
    for (const entry of readdirSync(directory, { withFileTypes: true }).filter((item) =>
      item.isDirectory()
    )) {
      try {
        const manifest = JSON.parse(
          readFileSync(path.join(directory, entry.name, "manifest.json"), "utf8")
        ) as Manifest;
        if (
          manifest.record_type !== "import_manifest" ||
          manifest.source_type !== source.name ||
          manifest.import_id !== entry.name ||
          manifest.status === "failed"
        )
          continue;
        if (
          hash(`${manifest.source_type}\n${manifest.original_path}\n${manifest.content_sha256}`) !==
          manifest.import_id
        )
          continue;
        const previous = latest.get(manifest.original_path);
        if (!previous || manifest.imported_at > previous.imported_at)
          latest.set(manifest.original_path, manifest);
      } catch {
        /* malformed derived import is ignored */
      }
    }
    const byContent = new Map<string, Manifest>();
    for (const manifest of latest.values()) {
      const previous = byContent.get(manifest.content_sha256);
      if (!previous) {
        byContent.set(manifest.content_sha256, manifest);
        continue;
      }
      const imports = path.resolve(root, "imports"),
        sourceExists = (candidate: Manifest) => {
          const sourcePath = path.resolve(imports, candidate.original_path);
          return sourcePath.startsWith(`${imports}${path.sep}`) && existsSync(sourcePath);
        },
        manifestExists = sourceExists(manifest),
        previousExists = sourceExists(previous);
      if (
        (manifestExists && !previousExists) ||
        (manifestExists === previousExists &&
          (manifest.original_path.length < previous.original_path.length ||
            (manifest.original_path.length === previous.original_path.length &&
              manifest.original_path.localeCompare(previous.original_path) < 0)))
      )
        byContent.set(manifest.content_sha256, manifest);
    }
    for (const manifest of byContent.values()) {
      try {
        const rows = JSON.parse(
          readFileSync(path.join(directory, manifest.import_id, source.data), "utf8")
        ) as Trade[];
        result.push(
          ...rows
            .filter(
              (row) =>
                row.source?.import_id === manifest.import_id &&
                row.source?.original_path === manifest.original_path &&
                row.source?.content_sha256 === manifest.content_sha256
            )
            .map((row) => ({ ...row, source_type: source.name }))
        );
      } catch {
        /* incomplete derived import is ignored */
      }
    }
  }
  const zerodhaKeys = new Set(
    result
      .filter((trade) => trade.source_type === "zerodha_tradebook")
      .map(tradeOverlapKey)
      .filter((key): key is string => Boolean(key))
  );
  return result
    .filter(
      (trade) =>
        trade.source_type !== "kuvera_transactions" ||
        !zerodhaKeys.has(tradeOverlapKey(trade) ?? "")
    )
    .filter((row) => validDate(row.trade_date) && numeric(row.quantity) && numeric(row.price))
    .sort(
      (left, right) =>
        left.trade_date.localeCompare(right.trade_date) ||
        left.source_id.localeCompare(right.source_id)
    );
}

function tradeOverlapKey(trade: Trade): string | null {
  const quantity = numeric(trade.quantity),
    price = numeric(trade.price),
    name = fundNameKey(trade.instrument);
  if (!validDate(trade.trade_date) || !quantity || !price || !name) return null;
  return [
    trade.trade_date,
    trade.side,
    Number(quantity).toString(),
    Number(price).toString(),
    safePart(trade.currency, "").toUpperCase(),
    name
  ].join("|");
}

function commodityForHolding(row: Record): string {
  const security = row.security ?? {};
  const identifier =
    row.source_type === "nsdl_cas_holdings" && isMutualFund(row)
      ? security.identifier?.split(":", 1)[0]
      : security.identifier;
  return safeCommodity(
    row.source_type === "zerodha_kite_api"
      ? identifier ?? security.symbol ?? security.name
      : security.symbol ?? identifier ?? security.name,
    `H_${row.source_id.slice(0, 10)}`
  );
}

function accountForHolding(row: Record): string {
  const security = row.security ?? {},
    commodity = commodityForHolding(row);
  const category = safePart(security.category, "Investments"),
    classification = assetClass(security.category, true);
  const suffix =
    row.source_type === "nsdl_cas_holdings" && security.category === "mutual_fund_folio"
      ? safePart(commodity, row.source_id.slice(0, 8))
      : row.source_id.slice(0, 8);
  return `Assets:${classification}:${category}:${safePart(
    security.name ?? security.symbol ?? security.identifier,
    commodity
  )}_${suffix}`;
}

function holdingEntry(row: Record, date: string, unitsOverride?: number): string | null {
  const value = numeric(row.current_value),
    units = numeric(row.units);
  const outputUnits = unitsOverride ?? Number(units);
  if (!value || !units || !Number.isFinite(outputUnits) || Math.abs(outputUnits) < 0.00000001)
    return null;
  const commodity = commodityForHolding(row);
  const price = Number(value) / Number(units);
  if (!Number.isFinite(price)) return null;
  const unitPrice = price.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  return `${date} Imported holding adjustment (${row.source.original_path}:${
    row.source.record_locator
  })\n    ${accountForHolding(row)}    ${formatQuantity(
    outputUnits
  )} "${commodity}" @ ${unitPrice} ${safePart(row.currency, "INR")}\n    Equity:OpeningBalance\n`;
}

function priceEntry(row: Record, date: string): string | null {
  const value = numeric(row.current_value),
    units = numeric(row.units);
  if (!value || !units || Number(units) === 0) return null;
  const price = Number(value) / Number(units);
  return Number.isFinite(price)
    ? `P ${date} "${commodityForHolding(row)}" ${price
        .toFixed(8)
        .replace(/0+$/, "")
        .replace(/\.$/, "")} ${safePart(row.currency, "INR")}\n`
    : null;
}

function commodityForTrade(trade: Trade): string {
  return safeCommodity(
    trade.isin ?? trade.folio ?? trade.instrument,
    `T_${trade.source_id.slice(0, 10)}`
  );
}
function tradeEntry(
  trade: Trade,
  account: string,
  commodity = commodityForTrade(trade)
): string | null {
  const quantity = numeric(trade.quantity),
    price = numeric(trade.price);
  if (!quantity || !price) return null;
  const signed = trade.side === "sell" ? `-${quantity}` : quantity;
  return `${trade.trade_date} Imported ${trade.side} (${trade.source.original_path}:${
    trade.source.record_locator
  })\n    ${account}    ${signed} "${commodity}" @ ${price} ${safePart(
    trade.currency,
    "INR"
  )}\n    Equity:OpeningBalance\n`;
}

function balanceEntry(row: Record, date: string): string | null {
  const value = numeric(row.amount);
  if (
    !value ||
    row.balance_type === "cash_flow" ||
    /\breal[_ ]?asset|property\b/i.test(row.category ?? "")
  )
    return null;
  const classification =
    row.balance_type === "liability"
      ? safePart(row.category, "Other")
      : assetClass(row.category, false);
  const root = row.balance_type === "liability" ? "Liabilities" : "Assets";
  const account = `${root}:${classification}:${safePart(
    row.label,
    `Balance_${row.source_id.slice(0, 8)}`
  )}`;
  const postingValue =
    row.balance_type === "liability" && !value.startsWith("-") ? `-${value}` : value;
  return `${date} Imported balance (${row.source.original_path}:${
    row.source.record_locator
  })\n    ${account}    ${postingValue} ${safePart(
    row.currency,
    "INR"
  )}\n    Equity:OpeningBalance\n`;
}

function installInclude(journal: string, output: string): boolean {
  const journalPath = path.resolve(journal);
  if (!statSync(journalPath).isFile())
    throw new Error("--journal must name an existing Ledger journal file.");
  const include = `include ${path
    .relative(path.dirname(journalPath), output)
    .replaceAll(path.sep, "/")}`;
  const existing = readFileSync(journalPath, "utf8");
  if (existing.split(/\r?\n/).some((line) => line.trim() === include)) return false;
  atomicWrite(
    journalPath,
    `${existing.replace(/\s*$/, "")}\n\n; Generated imported-balance snapshot\n${include}\n`
  );
  return true;
}

export function exportLedgerSnapshot(
  options: LedgerSnapshotExportOptions
): LedgerSnapshotExportResult {
  const root = path.resolve(options.root);
  if (!statSync(path.join(root, "imports")).isDirectory())
    throw new Error("Finance root does not contain an imports folder.");
  if (options.asOfDate && !validDate(options.asOfDate))
    throw new Error("--as-of must use YYYY-MM-DD.");
  const entries: string[] = [],
    prices: string[] = [],
    skipped: LedgerSnapshotExportResult["skipped"] = [];
  const rows = readLatest(root),
    holdings = rows.filter((row) => row.record_type === "holding"),
    eligibleHoldings = holdings.filter((row) => validDate(row.as_of_date) || options.asOfDate);
  const holdingTargets = new Map<
    string,
    { account: string; commodity: string; sourceId: string }
  >();
  const holdingTargetsByName = new Map<
    string,
    { account: string; commodity: string; sourceId: string } | null
  >();
  for (const row of eligibleHoldings) {
    const commodity = commodityForHolding(row),
      target = { account: accountForHolding(row), commodity, sourceId: row.source_id },
      identifier = String(row.security?.identifier ?? "").trim(),
      folio = identifier.includes(":")
        ? identifier.slice(identifier.lastIndexOf(":") + 1)
        : identifier;
    holdingTargets.set(commodity, target);
    if (folio) holdingTargets.set(safeCommodity(folio, folio), target);
    if (isMutualFund(row)) {
      const nameKey = fundNameKey(row.security?.name),
        previous = holdingTargetsByName.get(nameKey);
      if (nameKey && previous !== null) {
        holdingTargetsByName.set(
          nameKey,
          previous &&
            (previous.account !== target.account || previous.commodity !== target.commodity)
            ? null
            : target
        );
      }
    }
  }
  const tradeUnitsByHolding = new Map<string, number>();
  for (const trade of readLatestTrades(root)) {
    const tradeCommodity = commodityForTrade(trade),
      target =
        holdingTargets.get(tradeCommodity) ??
        holdingTargetsByName.get(fundNameKey(trade.instrument)) ??
        undefined,
      commodity = target?.commodity ?? tradeCommodity,
      entry = tradeEntry(
        trade,
        target?.account ??
          `Assets:Equity:Investments:${safePart(
            trade.instrument,
            commodity
          )}_${trade.source_id.slice(0, 8)}`,
        commodity
      );
    if (!entry) {
      skipped.push({ source_id: trade.source_id, reason: "missing_or_invalid_amount" });
      continue;
    }
    entries.push(entry);
    if (!target) continue;
    tradeUnitsByHolding.set(
      target.sourceId,
      (tradeUnitsByHolding.get(target.sourceId) ?? 0) +
        (trade.side === "sell" ? -Number(trade.quantity) : Number(trade.quantity))
    );
  }
  for (const row of rows) {
    const date = validDate(row.as_of_date) ? row.as_of_date : options.asOfDate;
    if (!date) {
      skipped.push({ source_id: row.source_id, reason: "missing_as_of_date" });
      continue;
    }
    if (row.record_type === "holding") {
      const units = Number(row.units),
        residual = Number((units - (tradeUnitsByHolding.get(row.source_id) ?? 0)).toFixed(8)),
        price = priceEntry(row, date);
      if (price) prices.push(price);
      const entry = holdingEntry(row, date, residual);
      if (entry) entries.push(entry);
      else if (Math.abs(residual) >= 0.00000001)
        skipped.push({ source_id: row.source_id, reason: "missing_or_invalid_amount" });
      continue;
    }
    const entry = balanceEntry(row, date);
    if (!entry) {
      skipped.push({ source_id: row.source_id, reason: "missing_or_invalid_amount" });
      continue;
    }
    entries.push(entry);
  }
  const output = path.resolve(
    options.output ?? path.join(root, "generated", "paisa-imported-balances.ledger")
  );
  if (!options.dryRun)
    atomicWrite(
      output,
      `; This file is generated from local imported snapshots and transactions. Do not edit.\n; Re-run finance:export-ledger after refreshing imports.\n\n${prices.join(
        ""
      )}\n${entries.join("\n")}`
    );
  if (options.dryRun && options.journal)
    throw new Error("--dry-run cannot be combined with --journal.");
  return {
    output,
    included: entries.length,
    skipped,
    installed: options.journal ? installInclude(options.journal, output) : false,
    dry_run: Boolean(options.dryRun)
  };
}

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import Papa from "papaparse";

const SOURCE_TYPE = "manual_investment_trades";
export const MANUAL_INVESTMENT_TRADES_VERSION = "1.0.0";
const HEADERS = [
  "trade_date",
  "instrument",
  "isin",
  "side",
  "quantity",
  "price",
  "currency",
  "status",
  "type"
];

type ErrorRecord = { code: string; message: string; record_locator?: string };
type Trade = {
  record_type: "manual_investment_trade";
  source_id: string;
  trade_date: string;
  instrument: string;
  isin?: string;
  side: "buy" | "sell";
  quantity: string;
  price: string;
  currency: string;
  source: {
    import_id: string;
    original_path: string;
    content_sha256: string;
    record_locator: string;
  };
};
type ParsedTrade = Omit<Trade, "source_id" | "source"> & { record_locator: string };

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const decimal = (value: string) => /^\d+(?:\.\d+)?$/.test(value.trim()) && Number(value) > 0;
const date = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

function atomicWrite(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      /* no temporary file */
    }
    throw error;
  }
}

export function parseManualInvestmentTrades(input: Buffer | string): {
  trades: ParsedTrade[];
  errors: ErrorRecord[];
  read: number;
  skipped: number;
} {
  const parsed = Papa.parse<string[]>(typeof input === "string" ? input : input.toString("utf8"), {
    skipEmptyLines: true
  });
  const [header = [], ...rows] = parsed.data;
  if (
    header.length !== HEADERS.length ||
    header.some((value, index) => value.trim() !== HEADERS[index])
  ) {
    throw new Error("Unexpected manual investment-trades CSV layout.");
  }
  const trades: ParsedTrade[] = [];
  const errors: ErrorRecord[] = [];
  let skipped = 0;
  rows.forEach((row, index) => {
    const locator = `csv row ${index + 2}`;
    const [
      tradeDate = "",
      instrument = "",
      isin = "",
      side = "",
      quantity = "",
      price = "",
      currency = "",
      status = ""
    ] = row.map((value) => value.trim());
    if (status.toLowerCase() === "pending") {
      skipped++;
      return;
    }
    if (
      !date(tradeDate) ||
      !instrument ||
      !["buy", "sell"].includes(side) ||
      !decimal(quantity) ||
      !decimal(price) ||
      !/^[A-Z]{3}$/.test(currency) ||
      status.toLowerCase() !== "settled"
    ) {
      errors.push({
        code: "invalid_manual_investment_trade",
        message: "Required settled trade fields are missing or invalid.",
        record_locator: locator
      });
      return;
    }
    trades.push({
      record_type: "manual_investment_trade",
      trade_date: tradeDate,
      instrument,
      isin: isin || undefined,
      side: side as "buy" | "sell",
      quantity,
      price,
      currency,
      record_locator: locator
    });
  });
  return { trades, errors, read: rows.length, skipped };
}

export function importManualInvestmentTrades(options: {
  root: string;
  file: string;
  dryRun?: boolean;
  now?: Date;
}) {
  const root = path.resolve(options.root);
  const imports = realpathSync(path.join(root, "imports"));
  const relative = options.file.replaceAll("\\", "/");
  if (!/^manual\/investment-trades\/[^/]+\.csv$/i.test(relative))
    throw new Error("Manual investment trades must be a CSV under manual/investment-trades/.");
  const source = realpathSync(path.join(imports, relative));
  if (!source.startsWith(`${imports}${path.sep}`) || !statSync(source).isFile())
    throw new Error("Manual investment-trades source is unavailable.");
  const bytes = readFileSync(source);
  const contentSha256 = digest(bytes);
  const importId = digest(`${SOURCE_TYPE}\n${relative}\n${contentSha256}`);
  const output = path.join(root, "extracted", "imports", SOURCE_TYPE, importId);
  const manifestFile = path.join(output, "manifest.json");
  const tradesFile = path.join(output, "trades.json");
  if (existsSync(manifestFile) && existsSync(tradesFile)) {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (manifest.parser?.version === MANUAL_INVESTMENT_TRADES_VERSION)
      return {
        status: manifest.status,
        row_counts: manifest.row_counts,
        error_count: manifest.errors.length,
        already_imported: true,
        dry_run: Boolean(options.dryRun)
      };
  }
  let result: ReturnType<typeof parseManualInvestmentTrades>;
  try {
    result = parseManualInvestmentTrades(bytes);
  } catch (error) {
    result = {
      trades: [],
      errors: [
        {
          code: "file_parse_failed",
          message:
            error instanceof Error
              ? error.message
              : "Manual investment-trades CSV could not be parsed."
        }
      ],
      read: 0,
      skipped: 0
    };
  }
  const trades = result.trades.map(({ record_locator: locator, ...trade }) => {
    return {
      ...trade,
      source_id: digest(`${SOURCE_TYPE}\n${contentSha256}\n${locator}`),
      source: {
        import_id: importId,
        original_path: relative,
        content_sha256: contentSha256,
        record_locator: locator
      }
    };
  });
  const rejected = result.errors.filter((error) => error.record_locator).length;
  const status = trades.length === 0 ? "failed" : rejected ? "succeeded_with_errors" : "succeeded";
  const manifest = {
    record_type: "import_manifest",
    import_id: importId,
    source_type: SOURCE_TYPE,
    original_path: relative,
    content_sha256: contentSha256,
    imported_at: (options.now ?? new Date()).toISOString(),
    parser: { name: "manual-investment-trades-csv", version: MANUAL_INVESTMENT_TRADES_VERSION },
    status,
    row_counts: { read: result.read, accepted: trades.length, rejected, skipped: result.skipped },
    errors: result.errors
  };
  if (!options.dryRun) {
    atomicWrite(tradesFile, `${JSON.stringify(trades, null, 2)}\n`);
    atomicWrite(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return {
    status,
    row_counts: manifest.row_counts,
    error_count: result.errors.length,
    already_imported: false,
    dry_run: Boolean(options.dryRun)
  };
}

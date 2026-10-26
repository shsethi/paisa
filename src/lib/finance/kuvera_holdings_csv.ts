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
  writeFileSync,
} from "node:fs";
import path from "node:path";
import Papa from "papaparse";

export const KUVERA_HOLDINGS_IMPORT_VERSION = "1.0.1";
const sourceType = "kuvera_holdings";
const headers = [
  "Scheme Name",
  "Category",
  "Folio Number",
  "Invested",
  "Current Value",
  "Units",
  "NAV",
  "Avg NAV",
  "Total Returns",
  "xirr",
] as const;

export type KuveraHolding = {
  record_type: "holding";
  source_id: string;
  security: { name: string; identifier: string; category: string };
  units: string;
  cost_basis: string;
  current_value: string;
  nav: string;
  average_nav: string;
  total_returns_percent: string;
  xirr_percent: string;
  currency: "INR";
  as_of_date: string | null;
  source: { import_id: string; original_path: string; content_sha256: string; record_locator: string };
  review_status: "needs_review";
  review_reasons: string[];
};

export type KuveraHoldingError = { code: string; message: string; record_locator?: string };
export type KuveraHoldingsManifest = {
  record_type: "import_manifest";
  import_id: string;
  source_type: typeof sourceType;
  original_path: string;
  content_sha256: string;
  imported_at: string;
  as_of_date?: string;
  parser: { name: string; version: string };
  status: "succeeded" | "succeeded_with_errors" | "failed";
  row_counts: { read: number; accepted: number; rejected: number; skipped: number };
  errors: KuveraHoldingError[];
};

export type KuveraHoldingsImportResult = {
  status: KuveraHoldingsManifest["status"];
  row_counts: KuveraHoldingsManifest["row_counts"];
  error_count: number;
  already_imported: boolean;
  dry_run: boolean;
};

export type KuveraHoldingsImportOptions = { root?: string; file: string; dryRun?: boolean; now?: Date; asOfDate?: string };

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function decimal(value: string, allowNegative = false): string | null {
  const raw = value.trim().replaceAll(",", "");
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match || (match[1] && !allowNegative)) return null;
  const integer = match[2].replace(/^0+(?=\d)/, "");
  const fraction = match[3];
  const zero = /^0+$/.test(integer) && (!fraction || /^0+$/.test(fraction));
  return `${match[1] && !zero ? "-" : ""}${integer}${fraction === undefined ? "" : `.${fraction}`}`;
}

function validISODate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function discoverRoot(rootOption?: string): string {
  const configured = rootOption || process.env.PAISA_FINANCE_ROOT;
  if (configured) {
    const root = path.resolve(configured);
    if (!existsSync(path.join(root, "imports"))) throw new Error("Finance root does not contain an imports folder.");
    return root;
  }
  for (let directory = process.cwd(); ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, "My Finance");
    try { if (statSync(candidate).isDirectory()) return candidate; } catch { /* continue */ }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("Could not find My Finance; pass --root or set PAISA_FINANCE_ROOT.");
  }
}

function resolveSource(importsRoot: string, file: string): { absolute: string; relative: string } {
  const normalized = file.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (!file || path.isAbsolute(file) || segments.length !== 3 || segments[0] !== "investments" || segments[1] !== "kuvera" || !segments[2].toLowerCase().endsWith(".csv") || segments.some((s) => s === "." || s === "..")) {
    throw new Error("--file must name one .csv file under investments/kuvera/.");
  }
  const absolute = path.resolve(importsRoot, ...segments);
  let realImports: string;
  let realFile: string;
  try { realImports = realpathSync(importsRoot); realFile = realpathSync(absolute); } catch { throw new Error("The selected holdings CSV is not available."); }
  const relative = path.relative(realImports, realFile);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !statSync(realFile).isFile()) throw new Error("The selected holdings CSV must resolve beneath imports/.");
  return { absolute: realFile, relative: segments.join("/") };
}

export function parseKuveraHoldingsCSV(input: string | Buffer): { rows: KuveraHolding[]; readRows: number; skippedBlankRows: number; errors: KuveraHoldingError[] } {
  const text = typeof input === "string" && !input.includes("\n") && existsSync(input) ? readFileSync(input, "utf8") : input.toString();
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ""), { header: true, skipEmptyLines: "greedy", transformHeader: (h) => h.trim() });
  if (parsed.errors.length) throw new Error("Kuvera holdings CSV could not be parsed: malformed CSV.");
  const fields = parsed.meta.fields ?? [];
  if (fields.length !== headers.length || headers.some((header) => !fields.includes(header))) throw new Error("Unexpected Kuvera holdings CSV layout: required headers not found.");
  const errors: KuveraHoldingError[] = [];
  const rows: KuveraHolding[] = [];
  let skippedBlankRows = 0;
  parsed.data.forEach((raw, index) => {
    const rowNumber = index + 2;
    if (Object.values(raw).every((value) => !String(value ?? "").trim())) { skippedBlankRows++; return; }
    const name = raw["Scheme Name"]?.trim();
    const category = raw.Category?.trim();
    const folio = raw["Folio Number"]?.trim();
    const numbers = ["Invested", "Current Value", "Units", "NAV", "Avg NAV", "Total Returns", "xirr"] as const;
    const parsedNumbers = numbers.map((field) => decimal(raw[field] ?? "", field === "Total Returns" || field === "xirr"));
    if (!name || !category || !folio || parsedNumbers.some((value) => value === null)) {
      errors.push({ code: "invalid_holding_row", message: "Required holding fields are missing or not numeric.", record_locator: `csv row ${rowNumber}` });
      return;
    }
    rows.push({ record_type: "holding", source_id: "", security: { name, identifier: folio, category }, units: parsedNumbers[2]!, cost_basis: parsedNumbers[0]!, current_value: parsedNumbers[1]!, nav: parsedNumbers[3]!, average_nav: parsedNumbers[4]!, total_returns_percent: parsedNumbers[5]!, xirr_percent: parsedNumbers[6]!, currency: "INR", as_of_date: null, source: { import_id: "", original_path: "", content_sha256: "", record_locator: `csv row ${rowNumber}` }, review_status: "needs_review", review_reasons: ["Export does not include an as-of date; confirm the snapshot date."] });
  });
  const identifiers = new Map<string, number>();
  for (const row of rows) identifiers.set(row.security.identifier, (identifiers.get(row.security.identifier) ?? 0) + 1);
  for (const row of rows) {
    if ((identifiers.get(row.security.identifier) ?? 0) > 1) row.review_reasons.push("Folio number appears on multiple rows; confirm whether these are distinct holdings.");
  }
  return { rows, readRows: parsed.data.length + skippedBlankRows, skippedBlankRows, errors };
}

function atomicWrite(filePath: string, contents: string): void {
  const directory = path.dirname(filePath); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try { descriptor = openSync(temporaryPath, "wx", 0o600); writeFileSync(descriptor, contents, "utf8"); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined; renameSync(temporaryPath, filePath); } catch { if (descriptor !== undefined) closeSync(descriptor); try { unlinkSync(temporaryPath); } catch { /* noop */ } throw new Error("Could not write the local import output atomically."); }
}

export function importKuveraHoldingsFile(options: KuveraHoldingsImportOptions): KuveraHoldingsImportResult {
  if (options.asOfDate !== undefined && !validISODate(options.asOfDate)) throw new Error("--as-of must be an ISO date (YYYY-MM-DD).");
  const root = discoverRoot(options.root); const source = resolveSource(path.join(root, "imports"), options.file); const bytes = readFileSync(source.absolute); const contentSha256 = sha256(bytes); const importId = sha256(`${sourceType}\n${source.relative}\n${contentSha256}`); const outputDirectory = path.join(root, "extracted", "imports", "kuvera_holdings", importId); const manifestPath = path.join(outputDirectory, "manifest.json"); const holdingsPath = path.join(outputDirectory, "holdings.json");
  let previous: KuveraHoldingsManifest | null = null; try { previous = JSON.parse(readFileSync(manifestPath, "utf8")) as KuveraHoldingsManifest; } catch { /* first import */ }
  if (previous?.content_sha256 === contentSha256 && previous.parser?.version === KUVERA_HOLDINGS_IMPORT_VERSION && previous.as_of_date === options.asOfDate && existsSync(holdingsPath)) return { status: previous.status, row_counts: previous.row_counts, error_count: previous.errors.length, already_imported: true, dry_run: Boolean(options.dryRun) };
  const errors: KuveraHoldingError[] = []; let holdings: KuveraHolding[] = []; let read = 0; let skipped = 0;
  try { const parsed = parseKuveraHoldingsCSV(bytes); read = parsed.readRows; skipped = parsed.skippedBlankRows; errors.push(...parsed.errors); holdings = parsed.rows.map((holding) => ({ ...holding, as_of_date: options.asOfDate ?? holding.as_of_date, source_id: sha256(`${sourceType}\n${contentSha256}\n${holding.source.record_locator}`), source: { ...holding.source, import_id: importId, original_path: source.relative, content_sha256: contentSha256 } })); } catch (error) { errors.push({ code: "file_parse_failed", message: error instanceof Error && error.message.startsWith("Unexpected Kuvera") ? error.message : "CSV could not be parsed using the supported Kuvera holdings layout." }); }
  const rejected = errors.filter((error) => error.record_locator !== undefined).length; const status: KuveraHoldingsManifest["status"] = holdings.length === 0 ? "failed" : rejected > 0 ? "succeeded_with_errors" : "succeeded"; const manifest: KuveraHoldingsManifest = { record_type: "import_manifest", import_id: importId, source_type: sourceType, original_path: source.relative, content_sha256: contentSha256, imported_at: (options.now ?? new Date()).toISOString(), as_of_date: options.asOfDate, parser: { name: "kuvera-holdings-csv-import", version: KUVERA_HOLDINGS_IMPORT_VERSION }, status, row_counts: { read, accepted: holdings.length, rejected, skipped }, errors };
  if (!options.dryRun) { atomicWrite(holdingsPath, `${JSON.stringify(holdings, null, 2)}\n`); atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`); }
  return { status, row_counts: manifest.row_counts, error_count: errors.length, already_imported: false, dry_run: Boolean(options.dryRun) };
}

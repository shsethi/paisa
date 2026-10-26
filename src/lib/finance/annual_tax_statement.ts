import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import XlsxPopulate from "xlsx-populate";

export const ANNUAL_TAX_STATEMENT_VERSION = "1.0.2";
const sourceType = "annual_tax_statement";

export type AnnualTaxCredit = {
  record_type: "annual_tax_credit";
  source_id: string;
  financial_year: string | null;
  reported_period_label: string | null;
  section_code: string | null;
  transaction_date: string | null;
  amount_credited: string | null;
  tax_deducted: string | null;
  tax_deposited: string | null;
  currency: "INR";
  source: { import_id: string; original_path: string; content_sha256: string; sheet_name: string; record_locator: string; financial_year_source: "transaction_date" | null };
};
type ErrorRecord = { code: string; message: string; record_locator?: string };
type Manifest = { record_type: "import_manifest"; import_id: string; source_type: typeof sourceType; original_path: string; content_sha256: string; imported_at: string; parser: { name: string; version: string }; status: "succeeded" | "succeeded_with_errors" | "failed"; row_counts: { read: number; accepted: number; rejected: number; skipped: number }; errors: ErrorRecord[] };
export type AnnualTaxStatementResult = { status: Manifest["status"]; row_counts: Manifest["row_counts"]; error_count: number; already_imported: boolean; dry_run: boolean };

const clean = (value: unknown) => String(value ?? "").trim();
const normalized = (value: unknown) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const money = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(2);
  let text = clean(value).replace(/[₹,\s]/g, "");
  if (!text || text === "-" || text === "—") return null;
  const negative = text.startsWith("(") && text.endsWith(")");
  if (negative) text = text.slice(1, -1);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? (negative ? -number : number).toFixed(2) : null;
};
const dateValue = (value: unknown): string | null => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && Number.isFinite(value) && value > 10000 && value < 100000) return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10);
  const text = clean(value);
  const ymd = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, "0")}-${ymd[3].padStart(2, "0")}`;
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(text);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const monthName = /^(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ,]+(\d{4})$/.exec(text);
  if (monthName) {
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(monthName[2].slice(0, 3).toLowerCase()) + 1;
    if (month > 0) return `${monthName[3]}-${String(month).padStart(2, "0")}-${monthName[1].padStart(2, "0")}`;
  }
  return null;
};
const financialYearFromDate = (date: string | null): string | null => {
  if (!date) return null;
  const [year, month] = date.split("-").map(Number);
  return month >= 4 ? `${year}-${String((year + 1) % 100).padStart(2, "0")}` : `${year - 1}-${String(year % 100).padStart(2, "0")}`;
};

type HeaderMap = { section: number; date: number; credit: number; deducted: number; deposited: number };
type SheetLike = { cell(row: number, column: number): { value(): unknown }; usedRange(): { endCell(): { rowNumber(): number; columnNumber(): number } } | undefined; name(): string };
type WorkbookLike = { sheets(): SheetLike[] };
function findHeader(sheet: SheetLike, row: number, maxColumn: number): HeaderMap | null {
  const labels = Array.from({ length: maxColumn }, (_, i) => normalized(sheet.cell(row, i + 1).value()));
  const find = (pattern: RegExp) => labels.findIndex((value) => pattern.test(value));
  const section = find(/^section code$/);
  const date = find(/^(transaction date|date of transaction)$/);
  const credit = find(/^amount paid credited$/);
  const deducted = find(/^tax deducted$/);
  const deposited = find(/^(tds deposited|tax deposited)$/);
  if ([section, date, credit, deducted, deposited].some((v) => v < 0)) return null;
  return { section, date, credit, deducted, deposited };
}

export async function parseAnnualTaxStatement(input: Buffer, fileName = ""): Promise<{ records: AnnualTaxCredit[]; readRows: number; skippedRows: number; errors: ErrorRecord[]; sheet_names: string[] }> {
  let workbook: WorkbookLike;
  try { workbook = await (XlsxPopulate as unknown as { fromDataAsync(data: Buffer, options: object): Promise<WorkbookLike> }).fromDataAsync(input, {}); } catch { throw new Error("Annual Tax Statement workbook could not be read."); }
  const fyMatch = fileName.match(/(20\d{2})[-_](\d{2})/);
  const reportedPeriodLabel = fyMatch ? `${fyMatch[1]}-${fyMatch[2]}` : null;
  const records: AnnualTaxCredit[] = [];
  const errors: ErrorRecord[] = [];
  let readRows = 0;
  let skippedRows = 0;
  const sheets = workbook.sheets();
  for (const sheet of sheets) {
    const used = sheet.usedRange();
    if (!used) continue;
    const endRow = used.endCell().rowNumber();
    const endColumn = used.endCell().columnNumber();
    for (let row = 1; row <= endRow; row++) {
      const header = findHeader(sheet, row, endColumn);
      if (!header) continue;
      for (let dataRow = row + 1; dataRow <= endRow; dataRow++) {
        if (findHeader(sheet, dataRow, endColumn)) break;
        const values = [header.section, header.date, header.credit, header.deducted, header.deposited].map((column) => sheet.cell(dataRow, column + 1).value());
        if (values.every((value) => value === undefined || value === null || clean(value) === "")) {
          if (dataRow > row + 1) break;
          skippedRows++; continue;
        }
        const locator = `${sheet.name()}!row:${dataRow}`;
        const hasRecordFields = values.some((value) => value !== undefined && value !== null && clean(value) !== "");
        if (!hasRecordFields) { skippedRows++; continue; }
        readRows++;
        const sectionCode = clean(values[0]) || null;
        const transactionDate = dateValue(values[1]);
        const amountCredited = money(values[2]);
        const taxDeducted = money(values[3]);
        const taxDeposited = money(values[4]);
        if (!sectionCode && !transactionDate) { skippedRows++; continue; }
        if (!sectionCode || amountCredited === null || taxDeducted === null || taxDeposited === null) {
          errors.push({ code: "invalid_tax_credit_row", message: "Required section or tax amount is missing or invalid.", record_locator: locator });
          continue;
        }
        records.push({ record_type: "annual_tax_credit", source_id: "", financial_year: financialYearFromDate(transactionDate), reported_period_label: reportedPeriodLabel, section_code: sectionCode, transaction_date: transactionDate, amount_credited: amountCredited, tax_deducted: taxDeducted, tax_deposited: taxDeposited, currency: "INR", source: { import_id: "", original_path: "", content_sha256: "", sheet_name: sheet.name(), record_locator: locator, financial_year_source: transactionDate ? "transaction_date" : null } });
      }
    }
  }
  if (!records.length) throw new Error("Unsupported Annual Tax Statement layout: no withholding detail table found.");
  return { records, readRows, skippedRows, errors, sheet_names: sheets.map((sheet) => sheet.name()) };
}

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function getRoot(option?: string): string {
  const configured = option || process.env.PAISA_FINANCE_ROOT;
  if (configured) { const root = path.resolve(configured); if (existsSync(path.join(root, "imports"))) return root; throw new Error("Finance root does not contain an imports folder."); }
  for (let current = process.cwd(); ; current = path.dirname(current)) { const candidate = path.join(current, "My Finance"); if (existsSync(path.join(candidate, "imports"))) return candidate; if (path.dirname(current) === current) throw new Error("Could not find My Finance; pass --root or set PAISA_FINANCE_ROOT."); }
}
function atomicWrite(file: string, data: string) { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`); let fd: number | undefined; try { fd = openSync(temp, "wx", 0o600); writeFileSync(fd, data); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, file); } catch { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch { /* no temp file */ } throw new Error("Could not write local import output atomically."); } }

export async function importAnnualTaxStatement(options: { root?: string; file: string; dryRun?: boolean; now?: Date }): Promise<AnnualTaxStatementResult> {
  const root = getRoot(options.root);
  const parts = options.file.replaceAll("\\", "/").split("/");
  if (path.isAbsolute(options.file) || parts.length !== 3 || parts[0] !== "tax" || parts[1] !== "form-26as" || !parts[2].toLowerCase().endsWith(".xlsx") || parts.some((p) => p === "." || p === "..")) throw new Error("--file must name one .xlsx file under tax/form-26as/.");
  const imports = path.join(root, "imports");
  let sourcePath: string;
  try { sourcePath = realpathSync(path.join(imports, ...parts)); } catch { throw new Error("The selected Annual Tax Statement workbook is unavailable."); }
  const rel = path.relative(realpathSync(imports), sourcePath);
  if (rel.startsWith("..") || path.isAbsolute(rel) || !statSync(sourcePath).isFile()) throw new Error("The selected workbook must resolve beneath imports/.");
  const bytes = readFileSync(sourcePath); const digest = sha(bytes); const original = parts.join("/"); const importId = sha(`${sourceType}\n${original}\n${digest}`);
  const output = path.join(root, "extracted", "imports", sourceType, importId); const manifestPath = path.join(output, "manifest.json"); const recordsPath = path.join(output, "records.json");
  try { const old = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest; if (old.content_sha256 === digest && old.parser.version === ANNUAL_TAX_STATEMENT_VERSION && existsSync(recordsPath)) return { status: old.status, row_counts: old.row_counts, error_count: old.errors.length, already_imported: true, dry_run: Boolean(options.dryRun) }; } catch { /* new import */ }
  let parsed: Awaited<ReturnType<typeof parseAnnualTaxStatement>> | null = null; const errors: ErrorRecord[] = [];
  try { parsed = await parseAnnualTaxStatement(bytes, path.basename(sourcePath)); errors.push(...parsed.errors); } catch { errors.push({ code: "file_parse_failed", message: "Workbook could not be parsed using the supported Annual Tax Statement layout." }); }
  const records = parsed?.records.map((record) => ({ ...record, source_id: sha(`${sourceType}\n${digest}\n${record.source.record_locator}`), source: { ...record.source, import_id: importId, original_path: original, content_sha256: digest } })) ?? [];
  const rejected = errors.filter((error) => Boolean(error.record_locator)).length;
  const manifest: Manifest = { record_type: "import_manifest", import_id: importId, source_type: sourceType, original_path: original, content_sha256: digest, imported_at: (options.now ?? new Date()).toISOString(), parser: { name: "annual-tax-statement-xlsx", version: ANNUAL_TAX_STATEMENT_VERSION }, status: records.length === 0 ? "failed" : rejected ? "succeeded_with_errors" : "succeeded", row_counts: { read: parsed?.readRows ?? 0, accepted: records.length, rejected, skipped: parsed?.skippedRows ?? 0 }, errors };
  if (!options.dryRun) { atomicWrite(recordsPath, `${JSON.stringify(records, null, 2)}\n`); atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`); }
  return { status: manifest.status, row_counts: manifest.row_counts, error_count: errors.length, already_imported: false, dry_run: Boolean(options.dryRun) };
}

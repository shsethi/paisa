import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseZerodhaPnl, ZERODHA_PNL_PARSER_VERSION, type ZerodhaPnlRecord } from "./zerodha_pnl";

const sourceType = "zerodha_tax_pnl";

export type ZerodhaPnlManifest = {
  record_type: "import_manifest";
  import_id: string;
  source_type: string;
  original_path: string;
  content_sha256: string;
  imported_at: string;
  parser: { name: string; version: string };
  status: "succeeded" | "failed";
  row_counts: { read: number; accepted: number; rejected: number; skipped: number };
  errors: { code: string; message: string }[];
};

export type ZerodhaPnlImportOptions = { root?: string; file: string; dryRun?: boolean; now?: Date };
export type ZerodhaPnlImportResult = { status: ZerodhaPnlManifest["status"]; row_counts: ZerodhaPnlManifest["row_counts"]; error_count: number; already_imported: boolean; dry_run: boolean };

function sha256(data: Buffer | string): string { return createHash("sha256").update(data).digest("hex"); }
function discoverRoot(option?: string): string {
  const configured = option || process.env.PAISA_FINANCE_ROOT;
  if (configured) { const root = path.resolve(configured); if (!existsSync(path.join(root, "imports"))) throw new Error("Finance root does not contain an imports folder."); return root; }
  for (let directory = process.cwd(); ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, "My Finance");
    try { if (statSync(candidate).isDirectory()) return candidate; } catch { /* continue */ }
    const parent = path.dirname(directory); if (parent === directory) throw new Error("Could not find My Finance; pass --root or set PAISA_FINANCE_ROOT.");
  }
}
function resolveSource(root: string, file: string): { absolute: string; relative: string } {
  const normalized = file.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (path.isAbsolute(file) || parts.length !== 3 || parts[0] !== "investments" || parts[1] !== "zerodha" || !/\.xlsx?$/i.test(parts[2]) || parts.some((part) => part === ".." || part === ".")) throw new Error("--file must name one Excel workbook under investments/zerodha/.");
  const absolute = path.resolve(root, "imports", ...parts);
  let real: string; try { real = realpathSync(absolute); } catch { throw new Error("The selected Zerodha workbook is not available."); }
  const importsReal = realpathSync(path.join(root, "imports"));
  if (path.relative(importsReal, real).startsWith("..") || !statSync(real).isFile()) throw new Error("The selected workbook must resolve beneath imports/.");
  return { absolute: real, relative: parts.join("/") };
}
function atomicWrite(filePath: string, contents: string): void {
  const directory = path.dirname(filePath); mkdirSync(directory, { recursive: true, mode: 0o700 }); const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`); let fd: number | undefined;
  try { fd = openSync(temporary, "wx", 0o600); writeFileSync(fd, contents, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temporary, filePath); } catch { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch { /* no temp */ } throw new Error("Could not write the local import output atomically."); }
}

export function importZerodhaPnlFile(options: ZerodhaPnlImportOptions): ZerodhaPnlImportResult {
  const root = discoverRoot(options.root); const source = resolveSource(root, options.file); const bytes = readFileSync(source.absolute); const contentSha256 = sha256(bytes);
  const importId = sha256(`${sourceType}\n${source.relative}\n${contentSha256}`); const output = path.join(root, "extracted", "imports", "zerodha_pnl", importId); const manifestPath = path.join(output, "manifest.json"); const recordsPath = path.join(output, "records.json");
  try { const prior = JSON.parse(readFileSync(manifestPath, "utf8")) as ZerodhaPnlManifest; if (prior.content_sha256 === contentSha256 && prior.parser.version === ZERODHA_PNL_PARSER_VERSION && existsSync(recordsPath)) return { status: prior.status, row_counts: prior.row_counts, error_count: prior.errors.length, already_imported: true, dry_run: Boolean(options.dryRun) }; } catch { /* first import */ }
  let records: ZerodhaPnlRecord[] = []; let read = 0; let skipped = 0; const errors: ZerodhaPnlManifest["errors"] = [];
  try { const parsed = parseZerodhaPnl(bytes); records = parsed.records.map((record) => ({ ...record, source: { ...record.source, sheet_name: record.source.sheet_name } })); read = parsed.sheet_names.length; skipped = parsed.skipped_rows + parsed.skipped_sheets.length; } catch { errors.push({ code: "file_parse_failed", message: "Workbook could not be parsed using the supported Zerodha P&L layout." }); }
  const manifest: ZerodhaPnlManifest = { record_type: "import_manifest", import_id: importId, source_type: sourceType, original_path: source.relative, content_sha256: contentSha256, imported_at: (options.now ?? new Date()).toISOString(), parser: { name: "zerodha-pnl-import", version: ZERODHA_PNL_PARSER_VERSION }, status: records.length > 0 ? "succeeded" : "failed", row_counts: { read, accepted: records.length, rejected: errors.length, skipped }, errors };
  if (!options.dryRun) { atomicWrite(recordsPath, `${JSON.stringify(records, null, 2)}\n`); atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`); }
  return { status: manifest.status, row_counts: manifest.row_counts, error_count: errors.length, already_imported: false, dry_run: Boolean(options.dryRun) };
}

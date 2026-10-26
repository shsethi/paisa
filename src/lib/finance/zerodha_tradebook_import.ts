import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseZerodhaTradebookCSV } from "./zerodha_tradebook";
import { normalizeZerodhaTradebookRows, type ZerodhaTrade } from "./zerodha_tradebook_normalize";

export const ZERODHA_TRADEBOOK_IMPORT_VERSION = "1.0.0";
type ImportError = { code: string; message: string; record_locator?: string };
export type ZerodhaTradebookManifest = { record_type: "import_manifest"; import_id: string; source_type: "zerodha_tradebook"; original_path: string; content_sha256: string; imported_at: string; parser: { name: string; version: string }; status: "succeeded" | "succeeded_with_errors" | "failed"; row_counts: { read: number; accepted: number; rejected: number; skipped: number }; errors: ImportError[] };
export type ZerodhaTradebookImportResult = { status: ZerodhaTradebookManifest["status"]; row_counts: ZerodhaTradebookManifest["row_counts"]; error_count: number; already_imported: boolean; dry_run: boolean };
export type ZerodhaTradebookImportOptions = { root?: string; file: string; dryRun?: boolean; now?: Date };

const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
function root(rootOption?: string): string {
  const configured = rootOption || process.env.PAISA_FINANCE_ROOT;
  if (configured) { const resolved = path.resolve(configured); if (!existsSync(path.join(resolved, "imports"))) throw new Error("Finance root does not contain an imports folder."); return resolved; }
  for (let directory = process.cwd(); ; directory = path.dirname(directory)) { const candidate = path.join(directory, "My Finance"); try { if (statSync(candidate).isDirectory()) return candidate; } catch { /* continue */ } const parent = path.dirname(directory); if (parent === directory) throw new Error("Could not find My Finance; pass --root or set PAISA_FINANCE_ROOT."); }
}
function sourcePath(importsRoot: string, file: string): { absolute: string; relative: string } {
  if (!file || path.isAbsolute(file)) throw new Error("--file must be a relative path beneath imports/.");
  const segments = file.replaceAll("\\", "/").split("/");
  if (segments.length !== 3 || segments[0] !== "investments" || segments[1] !== "zerodha" || !segments[2].toLowerCase().endsWith(".csv") || segments.some((segment) => segment === ".." || segment === ".")) throw new Error("--file must name one .csv file under investments/zerodha/.");
  const absolute = path.resolve(importsRoot, ...segments); let realImports: string; let realFile: string;
  try { realImports = realpathSync(importsRoot); realFile = realpathSync(absolute); } catch { throw new Error("The selected tradebook is not available."); }
  const relative = path.relative(realImports, realFile); if (relative.startsWith("..") || path.isAbsolute(relative) || !statSync(realFile).isFile()) throw new Error("The selected tradebook must resolve beneath imports/.");
  return { absolute: realFile, relative: segments.join("/") };
}
function atomicWrite(filePath: string, contents: string): void { const directory = path.dirname(filePath); mkdirSync(directory, { recursive: true, mode: 0o700 }); const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`); let fd: number | undefined; try { fd = openSync(temporary, "wx", 0o600); writeFileSync(fd, contents, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temporary, filePath); } catch { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch { /* ignore */ } throw new Error("Could not write the local import output atomically."); } }
function readManifest(file: string): ZerodhaTradebookManifest | null { try { return JSON.parse(readFileSync(file, "utf8")) as ZerodhaTradebookManifest; } catch { return null; } }
function summary(manifest: ZerodhaTradebookManifest, alreadyImported: boolean, dryRun: boolean): ZerodhaTradebookImportResult { return { status: manifest.status, row_counts: manifest.row_counts, error_count: manifest.errors.length, already_imported: alreadyImported, dry_run: dryRun }; }

export function importZerodhaTradebookFile(options: ZerodhaTradebookImportOptions): ZerodhaTradebookImportResult {
  const financeRoot = root(options.root); const source = sourcePath(path.join(financeRoot, "imports"), options.file); const bytes = readFileSync(source.absolute); const contentSha256 = hash(bytes); const importId = hash(`zerodha_tradebook\n${source.relative}\n${contentSha256}`); const directory = path.join(financeRoot, "extracted", "imports", "zerodha_tradebook", importId); const manifestPath = path.join(directory, "manifest.json"); const tradesPath = path.join(directory, "trades.json"); const previous = readManifest(manifestPath);
  if (previous?.content_sha256 === contentSha256 && previous.parser?.version === ZERODHA_TRADEBOOK_IMPORT_VERSION && existsSync(tradesPath)) return summary(previous, true, Boolean(options.dryRun));
  let read = 0; let skipped = 0; let trades: ZerodhaTrade[] = []; const errors: ImportError[] = [];
  try { const parsed = parseZerodhaTradebookCSV(bytes); read = parsed.readRows; skipped = parsed.skippedBlankRows; const normalized = normalizeZerodhaTradebookRows(parsed.rows, { contentSha256, importId, originalPath: source.relative }); trades = normalized.accepted; errors.push(...normalized.errors); } catch (error) { errors.push({ code: "file_parse_failed", message: error instanceof Error && error.message.startsWith("Unexpected Zerodha") ? error.message : "Tradebook could not be parsed using the supported Zerodha CSV layout." }); }
  const rejected = errors.filter((error) => error.record_locator !== undefined).length; const status: ZerodhaTradebookManifest["status"] = trades.length === 0 ? "failed" : rejected > 0 ? "succeeded_with_errors" : "succeeded"; const manifest: ZerodhaTradebookManifest = { record_type: "import_manifest", import_id: importId, source_type: "zerodha_tradebook", original_path: source.relative, content_sha256: contentSha256, imported_at: (options.now ?? new Date()).toISOString(), parser: { name: "zerodha-tradebook-csv-import", version: ZERODHA_TRADEBOOK_IMPORT_VERSION }, status, row_counts: { read, accepted: trades.length, rejected, skipped }, errors };
  if (!options.dryRun) { atomicWrite(tradesPath, `${JSON.stringify(trades, null, 2)}\n`); atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`); }
  return summary(manifest, false, Boolean(options.dryRun));
}

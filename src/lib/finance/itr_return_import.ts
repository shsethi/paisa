import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseItrJson } from "./itr_json";
import { parseItrXml } from "./itr_xml";

const parserVersion = "1.0.0";
type ItrRecord = ReturnType<typeof parseItrJson> | ReturnType<typeof parseItrXml>;
type Manifest = { record_type: "import_manifest"; import_id: string; source_type: "itr_return_json" | "itr_return_xml"; original_path: string; content_sha256: string; imported_at: string; parser: { name: string; version: string }; status: "succeeded" | "failed"; row_counts: { read: number; accepted: number; rejected: number; skipped: number }; errors: Array<{ code: string; message: string }> };
export type ItrReturnImportResult = { status: Manifest["status"]; row_counts: Manifest["row_counts"]; error_count: number; already_imported: boolean; dry_run: boolean };
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function rootFor(option?: string): string {
  const configured = option || process.env.PAISA_FINANCE_ROOT;
  if (configured) { const root = path.resolve(configured); if (existsSync(path.join(root, "imports"))) return root; throw new Error("Finance root does not contain an imports folder."); }
  for (let current = process.cwd(); ; current = path.dirname(current)) { const candidate = path.join(current, "My Finance"); if (existsSync(path.join(candidate, "imports"))) return candidate; if (path.dirname(current) === current) throw new Error("Could not find My Finance; pass --root or set PAISA_FINANCE_ROOT."); }
}
function resolveFile(root: string, file: string): { absolute: string; relative: string; extension: string } {
  const parts = file.replaceAll("\\", "/").split("/");
  if (path.isAbsolute(file) || parts.length !== 3 || parts[0] !== "tax" || parts[1] !== "returns" || !/\.(json|xml)$/i.test(parts[2]) || parts.some((part) => part === "." || part === "..")) throw new Error("--file must name one JSON or XML file under tax/returns/.");
  const imports = path.join(root, "imports"); let absolute: string;
  try { absolute = realpathSync(path.join(imports, ...parts)); } catch { throw new Error("The selected ITR return file is unavailable."); }
  const relative = path.relative(realpathSync(imports), absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !statSync(absolute).isFile()) throw new Error("The selected ITR return must resolve beneath imports/.");
  return { absolute, relative: parts.join("/"), extension: path.extname(absolute).toLowerCase() };
}
function atomicWrite(file: string, data: string) { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`); let fd: number | undefined; try { fd = openSync(temp, "wx", 0o600); writeFileSync(fd, data); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, file); } catch { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch { /* no temp */ } throw new Error("Could not write local import output atomically."); } }

export function importItrReturnFile(options: { root?: string; file: string; dryRun?: boolean; now?: Date }): ItrReturnImportResult {
  const root = rootFor(options.root); const source = resolveFile(root, options.file); const bytes = readFileSync(source.absolute); const contentHash = sha(bytes); const sourceType = source.extension === ".xml" ? "itr_return_xml" : "itr_return_json"; const importId = sha(`${sourceType}\n${source.relative}\n${contentHash}`);
  const output = path.join(root, "extracted", "imports", "itr_returns", importId); const manifestPath = path.join(output, "manifest.json"); const recordPath = path.join(output, "return.json");
  try { const prior = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest; if (prior.content_sha256 === contentHash && prior.parser.version === parserVersion && existsSync(recordPath)) return { status: prior.status, row_counts: prior.row_counts, error_count: prior.errors.length, already_imported: true, dry_run: Boolean(options.dryRun) }; } catch { /* new source */ }
  const errors: Manifest["errors"] = []; let record: ItrRecord | null = null;
  try {
    const text = bytes.toString("utf8");
    record = source.extension === ".xml" ? parseItrXml(text, source.relative) : parseItrJson(text, source.relative);
    if (record.source.contentHash !== contentHash) throw new Error("Source hash mismatch.");
  } catch {
    errors.push({ code: "file_parse_failed", message: `Return file could not be parsed as a supported ITR ${source.extension.slice(1).toUpperCase()} layout.` });
  }
  const status: Manifest["status"] = record ? "succeeded" : "failed";
  const manifest: Manifest = { record_type: "import_manifest", import_id: importId, source_type: sourceType, original_path: source.relative, content_sha256: contentHash, imported_at: (options.now ?? new Date()).toISOString(), parser: { name: `itr-return-${source.extension.slice(1)}`, version: parserVersion }, status, row_counts: { read: 1, accepted: record ? 1 : 0, rejected: record ? 0 : 1, skipped: 0 }, errors };
  if (!options.dryRun) { if (record) atomicWrite(recordPath, `${JSON.stringify(record, null, 2)}\n`); atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`); }
  return { status, row_counts: manifest.row_counts, error_count: errors.length, already_imported: false, dry_run: Boolean(options.dryRun) };
}

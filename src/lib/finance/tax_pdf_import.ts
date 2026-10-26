import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FORM16_PARSER_VERSION, parseForm16PDF } from "./form16_pdf";
import { FORM26AS_PARSER_VERSION, parseForm26ASPDF } from "./form26as_pdf";

type Kind = "form16" | "form26as";
type Manifest = { record_type: "import_manifest"; import_id: string; source_type: Kind; original_path: string; content_sha256: string; imported_at: string; parser: { name: string; version: string }; status: "succeeded" | "failed"; row_counts: { read: number; accepted: number; rejected: number; skipped: number }; errors: Array<{ code: string; message: string }> };
export type TaxPdfImportResult = { status: Manifest["status"]; row_counts: Manifest["row_counts"]; error_count: number; already_imported: boolean; dry_run: boolean };

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function rootFor(option?: string) { const configured = option || process.env.PAISA_FINANCE_ROOT; if (configured) { const root = path.resolve(configured); if (existsSync(path.join(root, "imports"))) return root; throw new Error("Finance root does not contain an imports folder."); } for (let current = process.cwd(); ; current = path.dirname(current)) { const candidate = path.join(current, "My Finance"); if (existsSync(path.join(candidate, "imports"))) return candidate; if (path.dirname(current) === current) throw new Error("Could not find My Finance; pass --root or set PAISA_FINANCE_ROOT."); } }
function atomicWrite(file: string, data: string) { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`); let descriptor: number | undefined; try { descriptor = openSync(temp, "wx", 0o600); writeFileSync(descriptor, data); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined; renameSync(temp, file); } catch { if (descriptor !== undefined) closeSync(descriptor); try { unlinkSync(temp); } catch {} throw new Error("Could not write local import output atomically."); } }

export async function importTaxPDF(options: { kind: Kind; root?: string; file: string; dryRun?: boolean; now?: Date }): Promise<TaxPdfImportResult> {
  const root = rootFor(options.root); const folder = options.kind === "form16" ? "form-16" : "form-26as"; const parts = options.file.replaceAll("\\", "/").split("/");
  if (path.isAbsolute(options.file) || parts.length !== 3 || parts[0] !== "tax" || parts[1] !== folder || !parts[2].toLowerCase().endsWith(".pdf") || parts.some((part) => part === "." || part === "..")) throw new Error(`--file must name one .pdf file under tax/${folder}/.`);
  const imports = realpathSync(path.join(root, "imports")); let source: string; try { source = realpathSync(path.join(imports, ...parts)); } catch { throw new Error("The selected tax PDF is unavailable."); }
  if (path.relative(imports, source).startsWith("..") || !statSync(source).isFile()) throw new Error("The selected PDF must resolve beneath imports/.");
  const bytes = readFileSync(source); const digest = sha(bytes); const original = parts.join("/"); const importId = sha(`${options.kind}\n${original}\n${digest}`); const output = path.join(root, "extracted", "imports", options.kind, importId); const manifestPath = path.join(output, "manifest.json"); const recordPath = path.join(output, "summary.json"); const version = options.kind === "form16" ? FORM16_PARSER_VERSION : FORM26AS_PARSER_VERSION;
  try { const old = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest; if (old.content_sha256 === digest && old.parser.version === version && existsSync(recordPath)) return { status: old.status, row_counts: old.row_counts, error_count: old.errors.length, already_imported: true, dry_run: Boolean(options.dryRun) }; } catch {}
  let record: Awaited<ReturnType<typeof parseForm16PDF>> | Awaited<ReturnType<typeof parseForm26ASPDF>> | null = null; const errors: Manifest["errors"] = [];
  try { record = options.kind === "form16" ? await parseForm16PDF(bytes) : await parseForm26ASPDF(bytes); } catch { errors.push({ code: "file_parse_failed", message: `PDF could not be parsed using the supported ${options.kind === "form16" ? "Form 16" : "Form 26AS"} layout.` }); }
  const accepted = record ? (options.kind === "form16" ? (record as Awaited<ReturnType<typeof parseForm16PDF>>).fields.length : (record as Awaited<ReturnType<typeof parseForm26ASPDF>>).deductors.length) : 0;
  const manifest: Manifest = { record_type: "import_manifest", import_id: importId, source_type: options.kind, original_path: original, content_sha256: digest, imported_at: (options.now ?? new Date()).toISOString(), parser: { name: `${options.kind}-pdf-import`, version }, status: record ? "succeeded" : "failed", row_counts: { read: accepted, accepted, rejected: record ? 0 : 1, skipped: 0 }, errors };
  if (!options.dryRun) { atomicWrite(recordPath, `${JSON.stringify(record, null, 2)}\n`); atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`); }
  return { status: manifest.status, row_counts: manifest.row_counts, error_count: errors.length, already_imported: false, dry_run: Boolean(options.dryRun) };
}


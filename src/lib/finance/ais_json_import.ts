import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decryptAisUtilityJson, parseAisJson } from "./ais_json";

const parserVersion = "1.3.0";
type Manifest = { record_type: "import_manifest"; import_id: string; source_type: "ais_json"; original_path: string; content_sha256: string; imported_at: string; parser: { name: string; version: string }; status: "succeeded" | "failed"; row_counts: { read: number; accepted: number; rejected: number; skipped: number }; errors: Array<{ code: string; message: string }> };
export type AisImportResult = { status: Manifest["status"]; row_counts: Manifest["row_counts"]; error_count: number; already_imported: boolean; dry_run: boolean };
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function rootFor(option?: string): string { const configured = option || process.env.PAISA_FINANCE_ROOT; if (configured) { const root = path.resolve(configured); if (existsSync(path.join(root, "imports"))) return root; throw new Error("Finance root does not contain an imports folder."); } for (let current = process.cwd(); ; current = path.dirname(current)) { const candidate = path.join(current, "My Finance"); if (existsSync(path.join(candidate, "imports"))) return candidate; if (path.dirname(current) === current) throw new Error("Could not find My Finance; pass --root or set PAISA_FINANCE_ROOT."); } }
function atomicWrite(file: string, data: string) { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`); let fd: number | undefined; try { fd = openSync(temp, "wx", 0o600); writeFileSync(fd, data); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, file); } catch { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch { /* no temp */ } throw new Error("Could not write local import output atomically."); } }

export function importAisJsonFile(options: { root?: string; file: string; password?: string; dryRun?: boolean; now?: Date }): AisImportResult {
  const root = rootFor(options.root); const parts = options.file.replaceAll("\\", "/").split("/");
  if (path.isAbsolute(options.file) || parts.length !== 3 || parts[0] !== "tax" || parts[1] !== "ais" || !parts[2].toLowerCase().endsWith(".json") || parts.some((part) => part === "." || part === "..")) throw new Error("--file must name one .json file under tax/ais/.");
  const imports = path.join(root, "imports"); let absolute: string;
  try { absolute = realpathSync(path.join(imports, ...parts)); } catch { throw new Error("The selected AIS JSON file is unavailable."); }
  const relative = path.relative(realpathSync(imports), absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !statSync(absolute).isFile()) throw new Error("The selected AIS file must resolve beneath imports/.");
  const bytes = readFileSync(absolute); const digest = sha(bytes); const original = parts.join("/"); const importId = sha(`ais_json\n${original}\n${digest}`); const output = path.join(root, "extracted", "imports", "ais_json", importId); const manifestPath = path.join(output, "manifest.json"); const recordsPath = path.join(output, "facts.json");
  try { const prior = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest; if (prior.status === "succeeded" && prior.content_sha256 === digest && prior.parser.version === parserVersion && existsSync(recordsPath)) return { status: prior.status, row_counts: prior.row_counts, error_count: prior.errors.length, already_imported: true, dry_run: Boolean(options.dryRun) }; } catch { /* first import */ }
  let record: ReturnType<typeof parseAisJson> | null = null; const errors: Manifest["errors"] = [];
  try {
    const raw = bytes.toString("utf8");
    const plaintext = /^\s*[\[{]/.test(raw) ? raw : decryptAisUtilityJson(bytes, options.password ?? "");
    record = parseAisJson(plaintext, original);
    // Provenance is always bound to the source file's bytes. For encrypted
    // utility exports that differs from the decrypted JSON held in memory.
    record.source.contentHash = digest;
  } catch {
    errors.push({ code: "file_parse_failed", message: "AIS JSON could not be parsed. Encrypted utility downloads require the AIS_JSON_PASSWORD environment variable." });
  }
  const manifest: Manifest = { record_type: "import_manifest", import_id: importId, source_type: "ais_json", original_path: original, content_sha256: digest, imported_at: (options.now ?? new Date()).toISOString(), parser: { name: "ais-json-import", version: parserVersion }, status: record ? "succeeded" : "failed", row_counts: { read: record?.facts.length ?? 0, accepted: record?.facts.length ?? 0, rejected: record ? 0 : 1, skipped: 0 }, errors };
  if (!options.dryRun) { atomicWrite(recordsPath, `${JSON.stringify(record ?? { facts: [] }, null, 2)}\n`); atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`); }
  return { status: manifest.status, row_counts: manifest.row_counts, error_count: errors.length, already_imported: false, dry_run: Boolean(options.dryRun) };
}

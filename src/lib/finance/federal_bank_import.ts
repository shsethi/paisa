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
import type { BankTransaction } from "./icici_normalize";
import { normalizeFederalBankRows } from "./federal_bank_normalize";
import { parseFederalBankPDF } from "./federal_bank_pdf";

export const FEDERAL_BANK_IMPORT_VERSION = "1.0.1";
const sourceType = "federal_bank_statement";

type ImportError = {
  code: string;
  message: string;
  record_locator?: string;
};

export type FederalBankManifest = {
  record_type: "import_manifest";
  import_id: string;
  source_type: string;
  original_path: string;
  content_sha256: string;
  imported_at: string;
  parser: { name: string; version: string };
  status: "succeeded" | "succeeded_with_errors" | "failed";
  row_counts: { read: number; accepted: number; rejected: number; skipped: number };
  errors: ImportError[];
};

export type FederalBankImportResult = {
  status: FederalBankManifest["status"];
  row_counts: FederalBankManifest["row_counts"];
  error_count: number;
  already_imported: boolean;
  dry_run: boolean;
};

export type FederalBankImportOptions = {
  root?: string;
  file: string;
  password?: string;
  dryRun?: boolean;
  now?: Date;
};

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function discoverRoot(rootOption?: string): string {
  const configured = rootOption || process.env.PAISA_FINANCE_ROOT;
  if (configured) {
    const root = path.resolve(configured);
    if (!existsSync(path.join(root, "imports"))) {
      throw new Error("Finance root does not contain an imports folder.");
    }
    return root;
  }
  for (let directory = process.cwd(); ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, "My Finance");
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Continue looking in parent directories.
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error("Could not find My Finance; pass --root or set PAISA_FINANCE_ROOT.");
    }
  }
}

function resolveSource(importsRoot: string, file: string): { absolute: string; relative: string } {
  if (!file || path.isAbsolute(file)) {
    throw new Error("--file must be a relative path beneath imports/.");
  }
  const segments = file.replaceAll("\\", "/").split("/");
  if (
    segments.some((segment) => segment === ".." || segment === ".") ||
    segments.length !== 3 ||
    segments[0] !== "banking" ||
    segments[1] !== "federal" ||
    !segments[2].toLowerCase().endsWith(".pdf")
  ) {
    throw new Error("--file must name one .pdf file under banking/federal/.");
  }
  const absolute = path.resolve(importsRoot, ...segments);
  const realImports = realpathSync(importsRoot);
  const realFile = realpathSync(absolute);
  const relativeRealPath = path.relative(realImports, realFile);
  if (relativeRealPath.startsWith("..") || path.isAbsolute(relativeRealPath)) {
    throw new Error("The selected statement must resolve beneath imports/.");
  }
  if (!statSync(realFile).isFile()) throw new Error("The selected statement is not a file.");
  return { absolute: realFile, relative: segments.join("/") };
}

function atomicWrite(filePath: string, contents: string): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, filePath);
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw new Error("Could not write the local import output atomically.");
  }
}

function summarize(
  manifest: FederalBankManifest,
  alreadyImported: boolean,
  dryRun: boolean
): FederalBankImportResult {
  return {
    status: manifest.status,
    row_counts: manifest.row_counts,
    error_count: manifest.errors.length,
    already_imported: alreadyImported,
    dry_run: dryRun
  };
}

function readExistingManifest(filePath: string): FederalBankManifest | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as FederalBankManifest;
  } catch {
    return null;
  }
}

export async function importFederalBankFile(
  options: FederalBankImportOptions
): Promise<FederalBankImportResult> {
  const root = discoverRoot(options.root);
  const importsRoot = path.join(root, "imports");
  const source = resolveSource(importsRoot, options.file);
  let originalBytes: Buffer;
  try {
    originalBytes = readFileSync(source.absolute);
  } catch {
    throw new Error("The selected statement could not be read.");
  }
  const contentSha256 = sha256(originalBytes);
  const originalPath = source.relative;
  const importId = sha256(`${sourceType}\n${originalPath}\n${contentSha256}`);
  const outputDirectory = path.join(root, "extracted", "imports", "federal", importId);
  const manifestPath = path.join(outputDirectory, "manifest.json");
  const transactionsPath = path.join(outputDirectory, "transactions.json");
  const previous = readExistingManifest(manifestPath);
  if (
    previous &&
    previous.content_sha256 === contentSha256 &&
    previous.parser.version === FEDERAL_BANK_IMPORT_VERSION &&
    existsSync(transactionsPath)
  ) {
    return summarize(previous, true, Boolean(options.dryRun));
  }

  const errors: ImportError[] = [];
  let transactions: BankTransaction[] = [];
  let read = 0;
  let skipped = 0;
  try {
    const parsed = await parseFederalBankPDF(originalBytes, options.password);
    read = parsed.readRows;
    skipped = parsed.skippedRows;
    const normalized = normalizeFederalBankRows(parsed.rows, {
      contentSha256,
      importId,
      originalPath
    });
    transactions = normalized.accepted;
    errors.push(...normalized.errors);
  } catch (error) {
    errors.push({
      code: "file_parse_failed",
      message:
        error instanceof Error && error.message.startsWith("Unexpected Federal Bank PDF layout:")
          ? error.message
          : "PDF could not be parsed using the supported Federal Bank statement layout and password."
    });
  }

  const rejected = errors.filter((error) => error.record_locator !== undefined).length;
  const status: FederalBankManifest["status"] =
    transactions.length === 0 ? "failed" : rejected > 0 ? "succeeded_with_errors" : "succeeded";
  const manifest: FederalBankManifest = {
    record_type: "import_manifest",
    import_id: importId,
    source_type: sourceType,
    original_path: originalPath,
    content_sha256: contentSha256,
    imported_at: (options.now ?? new Date()).toISOString(),
    parser: { name: "federal-bank-pdf-import", version: FEDERAL_BANK_IMPORT_VERSION },
    status,
    row_counts: { read, accepted: transactions.length, rejected, skipped },
    errors
  };

  if (!options.dryRun) {
    atomicWrite(transactionsPath, `${JSON.stringify(transactions, null, 2)}\n`);
    atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return summarize(manifest, false, Boolean(options.dryRun));
}

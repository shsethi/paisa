import { importICICIFile } from "../src/lib/finance/icici_import";

function parseArgs(args: string[]) {
  const options: { file?: string; root?: string; dryRun: boolean; help: boolean } = {
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--file" || arg === "--root") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      if (arg === "--file") options.file = value;
      else options.root = value;
    } else {
      throw new Error("Unsupported command option.");
    }
  }
  return options;
}

function usage(): string {
  return [
    "Import one ICICI XLS statement into local extracted records.",
    "",
    "Usage:",
    '  npm run finance:import-icici -- --file "banking/icici/statement.xls" [--root "My Finance"] [--dry-run]',
    "",
    "--file is relative to My Finance/imports/ and must be beneath banking/icici/.",
    "--root overrides PAISA_FINANCE_ROOT and automatic My Finance discovery.",
    "--dry-run parses and summarizes without writing derived files.",
  ].join("\n");
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
  } else if (!options.file) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
  } else {
    const summary = importICICIFile({
      file: options.file,
      root: options.root,
      dryRun: options.dryRun,
    });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (summary.status === "failed") process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Import failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

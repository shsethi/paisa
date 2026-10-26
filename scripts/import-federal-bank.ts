import { importFederalBankFile } from "../src/lib/finance/federal_bank_import";

function parseArgs(args: string[]) {
  const options: {
    file?: string;
    root?: string;
    passwordEnv: string;
    dryRun: boolean;
    help: boolean;
  } = {
    passwordEnv: "FEDERAL_BANK_PDF_PASSWORD",
    dryRun: false,
    help: false
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--file" || arg === "--root" || arg === "--password-env") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      if (arg === "--file") options.file = value;
      else if (arg === "--root") options.root = value;
      else options.passwordEnv = value;
    } else {
      throw new Error("Unsupported command option.");
    }
  }
  return options;
}

function usage(): string {
  return [
    "Import one Federal Bank PDF statement into local extracted records.",
    "",
    "Usage:",
    '  npm run finance:import-federal-bank -- --file "banking/federal/statement.pdf" [--root "My Finance"] [--dry-run]',
    "",
    "--file is relative to My Finance/imports/ and must be beneath banking/federal/.",
    "Set FEDERAL_BANK_PDF_PASSWORD in the environment for a password-protected PDF.",
    "Use --password-env NAME to read the password from another environment variable.",
    "--root overrides PAISA_FINANCE_ROOT and automatic My Finance discovery.",
    "--dry-run parses and summarizes without writing derived files."
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
    const summary = await importFederalBankFile({
      file: options.file,
      root: options.root,
      password: process.env[options.passwordEnv],
      dryRun: options.dryRun
    });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (summary.status === "failed") process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Import failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

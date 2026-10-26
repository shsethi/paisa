import { importZerodhaTradebookFile } from "../src/lib/finance/zerodha_tradebook_import";

const args = process.argv.slice(2);
let file: string | undefined;
let root: string | undefined;
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--dry-run") dryRun = true;
  else if (arg === "--file" || arg === "--root") {
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    if (arg === "--file") file = value;
    else root = value;
  } else if (arg !== "--help" && arg !== "-h") throw new Error("Unsupported command option.");
}
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write('Import one Zerodha tradebook CSV.\nUsage: npm run finance:import-zerodha-tradebook -- --file "investments/zerodha/tradebook.csv" [--root "My Finance"] [--dry-run]\n');
} else if (!file) {
  process.stderr.write("--file is required.\n"); process.exitCode = 2;
} else {
  try {
    const result = importZerodhaTradebookFile({ file, root, dryRun });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === "failed") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Import failed."}\n`); process.exitCode = 1;
  }
}

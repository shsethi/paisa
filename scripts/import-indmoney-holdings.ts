import { importIndmoneyHoldings } from "../src/lib/finance/indmoney_holdings";

function options(args: string[]) {
  const result: { file?: string; root?: string; asOfDate?: string; dryRun: boolean } = { dryRun: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--file" || arg === "--root" || arg === "--as-of") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      if (arg === "--file") result.file = value; else if (arg === "--root") result.root = value; else result.asOfDate = value;
    } else if (arg !== "--help" && arg !== "-h") throw new Error("Unsupported command option.");
  }
  return result;
}

const args = process.argv.slice(2);
const usage = 'Usage: npm run finance:import-indmoney-holdings -- --file "investments/indmoney/holdings.xls" [--as-of YYYY-MM-DD] [--root "My Finance"] [--dry-run]';
try {
  const parsed = options(args);
  if (args.includes("--help") || args.includes("-h")) process.stdout.write(`${usage}\n`);
  else if (!parsed.file) { process.stderr.write(`${usage}\n`); process.exitCode = 2; }
  else {
    const result = importIndmoneyHoldings({ file: parsed.file, root: parsed.root, asOfDate: parsed.asOfDate, dryRun: parsed.dryRun });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === "failed") process.exitCode = 1;
  }
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Import failed."}\n`); process.exitCode = 1; }

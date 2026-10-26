import { exportLedgerSnapshot } from "../src/lib/finance/ledger_snapshot_export";

const usage = () => ["Generate a Ledger include from local imported holdings and manual balances.", "", "Usage:", '  npm run finance:export-ledger -- --root "My Finance" [--as-of YYYY-MM-DD] [--journal /path/to/main.ledger] [--dry-run]', "", "--as-of supplies a date for exports that do not provide one (for example, Kuvera).", "--journal adds the generated include once; omit it to inspect the generated file first.", "--dry-run reports the proposed export without writing files."].join("\n");
try {
  const args = process.argv.slice(2), options: { root?: string; asOfDate?: string; journal?: string; dryRun?: boolean } = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") { process.stdout.write(`${usage()}\n`); process.exit(0); }
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    if (arg !== "--root" && arg !== "--as-of" && arg !== "--journal") throw new Error("Unsupported command option.");
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    if (arg === "--root") options.root = value; else if (arg === "--as-of") options.asOfDate = value; else options.journal = value;
  }
  if (!options.root) { process.stderr.write(`${usage()}\n`); process.exitCode = 2; }
  else process.stdout.write(`${JSON.stringify(exportLedgerSnapshot({ root: options.root, asOfDate: options.asOfDate, journal: options.journal, dryRun: options.dryRun }))}\n`);
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Ledger export failed."}\n`); process.exitCode = 1; }

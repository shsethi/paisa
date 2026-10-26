import { importKuveraTransactionsFile } from "../src/lib/finance/kuvera_transactions_import";

const args = process.argv.slice(2); let file: string | undefined, root: string | undefined, dryRun = false;
for (let index = 0; index < args.length; index++) { const arg = args[index]; if (arg === "--dry-run") dryRun = true; else if (arg === "--file" || arg === "--root") { const value = args[++index]; if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`); if (arg === "--file") file = value; else root = value; } else if (arg !== "--help" && arg !== "-h") throw new Error("Unsupported command option."); }
if (args.includes("--help") || args.includes("-h")) process.stdout.write('Usage: npm run finance:import-kuvera-transactions -- --file "investments/kuvera/transactions.csv" [--root "My Finance"] [--dry-run]\n');
else if (!file) { process.stderr.write("--file is required.\n"); process.exitCode = 2; }
else { try { const result = importKuveraTransactionsFile({ file, root, dryRun }); process.stdout.write(`${JSON.stringify(result)}\n`); if (result.status === "failed") process.exitCode = 1; } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Import failed."}\n`); process.exitCode = 1; } }

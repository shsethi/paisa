import path from "node:path";
import { importAll } from "../src/lib/finance/import_all";

const usage = [
  "Scan supported source folders and import every new or changed file.",
  "",
  "Usage:",
  '  npm run finance:import-all -- --root "/path/to/My Finance" [--as-of YYYY-MM-DD] [--dry-run]',
  "",
  "Password-protected sources use FEDERAL_BANK_PDF_PASSWORD, AIS_JSON_PASSWORD, and NSDL_CAS_PDF_PASSWORD."
].join("\n");

try {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage}\n`);
  } else {
    let root = process.env.PAISA_FINANCE_ROOT;
    let asOfDate: string | undefined;
    let dryRun = false;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "--dry-run") {
        dryRun = true;
        continue;
      }
      if (arg !== "--root" && arg !== "--as-of") throw new Error(`Unsupported option: ${arg}`);
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      if (arg === "--root") root = value;
      else asOfDate = value;
    }
    if (!root) root = path.resolve(process.cwd(), "..", "My Finance");
    const report = await importAll({
      root,
      asOfDate,
      dryRun,
      federalPassword: process.env.FEDERAL_BANK_PDF_PASSWORD,
      aisPassword: process.env.AIS_JSON_PASSWORD,
      nsdlPassword: process.env.NSDL_CAS_PDF_PASSWORD
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.summary.failed > 0) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Import-all failed."}\n`);
  process.exitCode = 1;
}

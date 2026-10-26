import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { auditInvestmentHistoryRoot } from "../src/lib/finance/investment_history_audit";

try {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      'Usage: npm run finance:audit-investments -- --root "/path/to/My Finance" [--output dashboard/investment-history-audit.json]\n'
    );
  } else {
    let root = process.env.PAISA_FINANCE_ROOT ?? path.resolve(process.cwd(), "..", "My Finance");
    let output: string | undefined;
    for (let index = 0; index < args.length; index++) {
      const option = args[index];
      if (option !== "--root" && option !== "--output")
        throw new Error(`Unsupported option: ${option}`);
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
      if (option === "--root") root = value;
      else output = value;
    }
    const report = auditInvestmentHistoryRoot(root);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (output) {
      const destination = path.isAbsolute(output) ? output : path.join(path.resolve(root), output);
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, json, { mode: 0o600 });
    }
    process.stdout.write(json);
    if (report.status === "error") process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Investment-history audit failed."}\n`
  );
  process.exitCode = 1;
}

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { reconcileFinanceRoot } from "../src/lib/finance/finance_reconciliation";

try {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      'Usage: npm run finance:reconcile -- --root "/path/to/My Finance" [--output dashboard/reconciliation.json]\n'
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
    const report = reconcileFinanceRoot(root);
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
    `${error instanceof Error ? error.message : "Finance reconciliation failed."}\n`
  );
  process.exitCode = 1;
}

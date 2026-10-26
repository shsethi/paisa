import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { buildTaxReconciliation } from "../src/lib/finance/tax_reconciliation";
import type { ItrJsonRecord } from "../src/lib/finance/itr_json";
import type { ItrXmlRecord } from "../src/lib/finance/itr_xml";
import type { AisJsonRecord } from "../src/lib/finance/ais_json";
import type { AnnualTaxCredit } from "../src/lib/finance/annual_tax_statement";

function root() {
  if (process.env.PAISA_FINANCE_ROOT && existsSync(path.join(process.env.PAISA_FINANCE_ROOT, "extracted", "imports"))) return path.resolve(process.env.PAISA_FINANCE_ROOT);
  for (let current = process.cwd(); ; current = path.dirname(current)) { const candidate = path.join(current, "My Finance"); if (existsSync(path.join(candidate, "extracted", "imports"))) return candidate; if (path.dirname(current) === current) throw new Error("Could not find My Finance extracted imports; set PAISA_FINANCE_ROOT."); }
}
function recordsUnder<T>(directory: string, file: string): T[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => { const child = path.join(directory, entry); const recordPath = path.join(child, file); const manifestPath = path.join(child, "manifest.json"); if (!statSync(child).isDirectory() || !existsSync(recordPath)) return []; try { const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) as { status?: string } : null; if (manifest && manifest.status !== "succeeded" && manifest.status !== "succeeded_with_errors") return []; return [JSON.parse(readFileSync(recordPath, "utf8")) as T]; } catch { return []; } });
}
try {
  const dataRoot = root(); const imports = path.join(dataRoot, "extracted", "imports");
  const itr = recordsUnder<ItrJsonRecord | ItrXmlRecord>(path.join(imports, "itr_returns"), "return.json");
  const ais = recordsUnder<AisJsonRecord>(path.join(imports, "ais_json"), "facts.json");
  const statements = recordsUnder<AnnualTaxCredit[]>(path.join(imports, "annual_tax_statement"), "records.json").flat();
  process.stdout.write(`${JSON.stringify(buildTaxReconciliation({ itr, ais, annualTaxStatement: statements }), null, 2)}\n`);
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Reconciliation report failed."}\n`); process.exitCode = 1; }

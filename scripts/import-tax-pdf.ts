import { importTaxPDF } from "../src/lib/finance/tax_pdf_import";

const args = process.argv.slice(2); let kind: "form16" | "form26as" | undefined; let file: string | undefined; let root: string | undefined; let dryRun = false;
for (let index = 0; index < args.length; index++) { const arg = args[index]; if (arg === "--dry-run") dryRun = true; else if (arg === "--kind" || arg === "--file" || arg === "--root") { const value = args[++index]; if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`); if (arg === "--kind") { if (value !== "form16" && value !== "form26as") throw new Error("--kind must be form16 or form26as."); kind = value; } else if (arg === "--file") file = value; else root = value; } else if (arg !== "--help" && arg !== "-h") throw new Error("Unsupported command option."); }
if (args.includes("--help") || args.includes("-h")) process.stdout.write('Import a supported tax PDF locally.\nUsage: node --import=tsx scripts/import-tax-pdf.ts --kind form16|form26as --file "tax/<folder>/statement.pdf" [--dry-run]\n');
else if (!kind || !file) { process.stderr.write("--kind and --file are required.\n"); process.exitCode = 2; }
else { try { const result = await importTaxPDF({ kind, file, root, dryRun }); process.stdout.write(`${JSON.stringify(result)}\n`); if (result.status === "failed") process.exitCode = 1; } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Import failed."}\n`); process.exitCode = 1; } }


import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { importAisJsonFile } from "./ais_json_import";
import { importAnnualTaxStatement } from "./annual_tax_statement";
import { importFederalBankFile } from "./federal_bank_import";
import { importICICIFile } from "./icici_import";
import { importIndmoneyHoldings } from "./indmoney_holdings";
import { importIndmoneyOrdersFile } from "./indmoney_orders_import";
import { importIndmoneyTaxFile } from "./indmoney_tax_import";
import { importItrReturnFile } from "./itr_return_import";
import { importKuveraCapitalGainsFile } from "./kuvera_capital_gains_import";
import { importKuveraHoldingsFile } from "./kuvera_holdings_csv";
import { importKuveraTransactionsFile } from "./kuvera_transactions_import";
import { importManualBalancesFile } from "./manual_balances_import";
import { importManualInvestmentTrades } from "./manual_investment_trades";
import { importNsdlCas } from "./nsdl_cas_import";
import { importTaxPDF } from "./tax_pdf_import";
import { importZerodhaPnlFile } from "./zerodha_pnl_import";
import { importZerodhaTradebookFile } from "./zerodha_tradebook_import";

export type ImportKind =
  | "ais_json"
  | "annual_tax_statement"
  | "federal"
  | "form16"
  | "form26as"
  | "icici"
  | "indmoney_holdings"
  | "indmoney_orders"
  | "indmoney_tax"
  | "itr_return"
  | "kuvera_capital_gains"
  | "kuvera_holdings"
  | "kuvera_transactions"
  | "manual_balances"
  | "manual_investment_trades"
  | "nsdl_cas"
  | "zerodha_pnl"
  | "zerodha_tradebook";

export type ImportCandidate = { kind: ImportKind; file: string };
export type ImportAllItem = ImportCandidate & {
  status: string;
  already_imported: boolean;
  row_counts?: { read: number; accepted: number; rejected: number; skipped: number };
  error_count: number;
  message?: string;
};
export type ImportAllReport = {
  root: string;
  dry_run: boolean;
  discovered: number;
  unsupported: string[];
  results: ImportAllItem[];
  summary: {
    succeeded: number;
    succeeded_with_errors: number;
    failed: number;
    already_imported: number;
  };
};

const normalized = (file: string) => file.replaceAll(path.sep, "/");
const extension = (file: string) => path.extname(file).toLowerCase();

export function classifyImportFile(file: string): ImportKind | null {
  const relative = normalized(file);
  const lower = relative.toLowerCase();
  const ext = extension(lower);
  const name = path.basename(lower);
  const parts = lower.split("/");

  if (lower.startsWith("_inbox/")) return null;
  if (parts.length !== 3) return null;
  if (lower.startsWith("banking/icici/") && ext === ".xls") return "icici";
  if (lower.startsWith("banking/federal/") && ext === ".pdf") return "federal";
  if (
    lower.startsWith("investments/zerodha/") &&
    /tax.?pnl/.test(name) &&
    [".xls", ".xlsx"].includes(ext)
  )
    return "zerodha_pnl";
  if (lower.startsWith("investments/zerodha/") && ext === ".csv" && /tradebook/.test(name))
    return "zerodha_tradebook";
  if (
    lower.startsWith("investments/kuvera/") &&
    [".xls", ".xlsx"].includes(ext) &&
    /(capital|cg[_ -]?report)/.test(name)
  )
    return "kuvera_capital_gains";
  if (lower.startsWith("investments/kuvera/") && ext === ".csv" && /transaction/.test(name))
    return "kuvera_transactions";
  if (lower.startsWith("investments/kuvera/") && ext === ".csv" && /(holding|portfolio)/.test(name))
    return "kuvera_holdings";
  if (lower.startsWith("investments/indmoney/") && ext === ".xls" && /holding/.test(name))
    return "indmoney_holdings";
  if (
    lower.startsWith("investments/indmoney/") &&
    [".xls", ".xlsx"].includes(ext) &&
    /order/.test(name)
  )
    return "indmoney_orders";
  if (lower.startsWith("investments/indmoney/") && [".xls", ".xlsx"].includes(ext))
    return "indmoney_tax";
  if (lower.startsWith("investments/cas/") && ext === ".pdf") return "nsdl_cas";
  if (lower.startsWith("manual/assets-liabilities/") && ext === ".csv") return "manual_balances";
  if (lower.startsWith("manual/investment-trades/") && ext === ".csv")
    return "manual_investment_trades";
  if (lower.startsWith("tax/returns/") && [".json", ".xml"].includes(ext)) return "itr_return";
  if (lower.startsWith("tax/ais/") && ext === ".json") return "ais_json";
  if (lower.startsWith("tax/form-16/") && ext === ".pdf") return "form16";
  if (lower.startsWith("tax/form-26as/") && ext === ".pdf") return "form26as";
  if (lower.startsWith("tax/form-26as/") && ext === ".xlsx") return "annual_tax_statement";
  return null;
}

function filesUnder(directory: string, prefix = ""): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...filesUnder(absolute, relative));
    else if (entry.isFile() && statSync(absolute).isFile()) output.push(relative);
  }
  return output;
}

export function discoverImportCandidates(root: string): {
  candidates: ImportCandidate[];
  unsupported: string[];
} {
  const imports = path.join(path.resolve(root), "imports");
  if (!statSync(imports).isDirectory())
    throw new Error("Finance root does not contain an imports folder.");
  const candidates: ImportCandidate[] = [];
  const unsupported: string[] = [];
  for (const file of filesUnder(imports).sort()) {
    if (file.startsWith("_inbox/")) continue;
    const kind = classifyImportFile(file);
    if (kind) candidates.push({ kind, file });
    else unsupported.push(file);
  }
  return { candidates, unsupported };
}

type CommonResult = {
  status: string;
  already_imported: boolean;
  row_counts?: { read: number; accepted: number; rejected: number; skipped: number };
  error_count: number;
};

export type ImportAllOptions = {
  root: string;
  dryRun?: boolean;
  asOfDate?: string;
  federalPassword?: string;
  aisPassword?: string;
  nsdlPassword?: string;
};

async function execute(
  candidate: ImportCandidate,
  options: ImportAllOptions
): Promise<CommonResult> {
  const common = { root: options.root, file: candidate.file, dryRun: options.dryRun };
  switch (candidate.kind) {
    case "icici":
      return importICICIFile(common);
    case "federal":
      return importFederalBankFile({ ...common, password: options.federalPassword });
    case "zerodha_tradebook":
      return importZerodhaTradebookFile(common);
    case "zerodha_pnl":
      return importZerodhaPnlFile(common);
    case "kuvera_holdings":
      return importKuveraHoldingsFile({ ...common, asOfDate: options.asOfDate });
    case "kuvera_transactions":
      return importKuveraTransactionsFile(common);
    case "kuvera_capital_gains":
      return importKuveraCapitalGainsFile(common);
    case "indmoney_holdings":
      return importIndmoneyHoldings({ ...common, asOfDate: options.asOfDate });
    case "indmoney_orders":
      return importIndmoneyOrdersFile(common);
    case "indmoney_tax":
      return importIndmoneyTaxFile(common);
    case "nsdl_cas":
      return importNsdlCas({ ...common, password: options.nsdlPassword });
    case "manual_balances":
      return importManualBalancesFile(common);
    case "manual_investment_trades":
      return importManualInvestmentTrades(common);
    case "itr_return":
      return importItrReturnFile(common);
    case "ais_json":
      return importAisJsonFile({ ...common, password: options.aisPassword });
    case "annual_tax_statement":
      return importAnnualTaxStatement(common);
    case "form16":
      return importTaxPDF({ ...common, kind: "form16" });
    case "form26as":
      return importTaxPDF({ ...common, kind: "form26as" });
  }
}

export async function importAll(options: ImportAllOptions): Promise<ImportAllReport> {
  const root = path.resolve(options.root);
  const { candidates, unsupported } = discoverImportCandidates(root);
  const results: ImportAllItem[] = [];
  for (const candidate of candidates) {
    try {
      const result = await execute(candidate, { ...options, root });
      results.push({ ...candidate, ...result });
    } catch (error) {
      results.push({
        ...candidate,
        status: "failed",
        already_imported: false,
        error_count: 1,
        message: error instanceof Error ? error.message : "Import failed."
      });
    }
  }
  return {
    root,
    dry_run: Boolean(options.dryRun),
    discovered: candidates.length,
    unsupported,
    results,
    summary: {
      succeeded: results.filter((item) => item.status === "succeeded").length,
      succeeded_with_errors: results.filter((item) => item.status === "succeeded_with_errors")
        .length,
      failed: results.filter((item) => item.status === "failed").length,
      already_imported: results.filter((item) => item.already_imported).length
    }
  };
}

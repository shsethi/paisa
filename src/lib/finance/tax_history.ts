export type TaxValue = number | null | undefined;

export interface TaxHistoryCapitalGain {
  source?: string | null;
  short_term?: TaxValue;
  long_term?: TaxValue;
  total?: TaxValue;
  [key: string]: unknown;
}

export interface TaxHistoryYear {
  year: string;
  regime?: string | null;
  income_heads?: Record<string, TaxValue> | null;
  deductions?: Record<string, TaxValue> | null;
  tax?: TaxValue;
  refund?: TaxValue;
  payable?: TaxValue;
  capital_gains?: TaxHistoryCapitalGain[] | null;
  source?: string | null;
  filing_version?: string | null;
}

export interface TaxHistoryResponse {
  years?: TaxHistoryYear[];
  history?: TaxHistoryYear[];
}

const numberValue = (value: unknown): TaxValue => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replaceAll(",", ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const mapValues = (value: unknown): Record<string, TaxValue> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, numberValue(item)])
  );
};

export function normalizeTaxHistory(payload: unknown): TaxHistoryYear[] {
  const root = (payload && typeof payload === "object" ? payload : {}) as TaxHistoryResponse;
  const rows = Array.isArray(root.years)
    ? root.years
    : Array.isArray(root.history)
      ? root.history
      : normalizeImportedReturns((root as { returns?: unknown[] }).returns);
  return rows
    .filter((row): row is TaxHistoryYear => !!row && typeof row === "object")
    .map((row, index) => ({
      ...row,
      year: String(row.year ?? `Year ${index + 1}`),
      income_heads: mapValues(row.income_heads),
      deductions: mapValues(row.deductions),
      tax: numberValue(row.tax),
      refund: numberValue(row.refund),
      payable: numberValue(row.payable),
      capital_gains: Array.isArray(row.capital_gains)
        ? row.capital_gains.map((gain) => ({
            ...gain,
            short_term: numberValue(gain.short_term),
            long_term: numberValue(gain.long_term),
            total: numberValue(gain.total)
          }))
        : null
    }));
}

/** Convert the provenance-preserving API envelope into one card per imported return. */
function normalizeImportedReturns(returns: unknown[] | undefined): TaxHistoryYear[] {
  if (!Array.isArray(returns)) return [];
  return returns.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, any>;
    const record = row.record && typeof row.record === "object" ? row.record : {};
    const identity = record.identity && typeof record.identity === "object" ? record.identity : {};
    const value = (key: string) => {
      const found = Array.isArray(record[key]) ? record[key].find((entry: any) => entry?.key === key || entry?.key?.toLowerCase?.().includes(key)) : null;
      return numberValue(found?.value);
    };
    const values = (key: string) => {
      const entries = Array.isArray(record[key]) ? record[key] : [];
      return Object.fromEntries(entries.filter((entry: any) => entry?.key).map((entry: any) => [entry.key, numberValue(entry.value)]));
    };
    const financialYear = identity.financialYear?.value;
    if (!financialYear) return [];
    const taxes = values("taxes");
    const findTax = (pattern: RegExp) => Object.entries(taxes).find(([key]) => pattern.test(key))?.[1] ?? null;
    const source = row.original_path ?? record.source?.path ?? null;
    return [{
      year: String(financialYear),
      regime: identity.regime?.value ?? null,
      income_heads: values("incomeHeads"),
      deductions: values("deductions"),
      tax: findTax(/total|tax payable|tax liability/i),
      refund: findTax(/refund/i),
      payable: findTax(/payable|demand/i),
      capital_gains: Array.isArray(record.capitalGains)
        ? [{ source, ...Object.fromEntries(record.capitalGains.filter((entry: any) => entry?.key).map((entry: any) => [entry.key, numberValue(entry.value)])) }]
        : null,
      source,
      filing_version: identity.filingVersion ?? null
    }];
  });
}

export function isMissing(value: TaxValue): boolean {
  return value === null || value === undefined;
}

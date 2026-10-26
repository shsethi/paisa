/** Pure portfolio-allocation calculations.
 *
 * Values are deliberately numbers here: callers can parse values from an
 * importer at the boundary, while this module remains independent of any
 * particular broker or storage format.
 */

export type HoldingRecord = {
  id?: string;
  security?: string | { symbol?: string; id?: string };
  holdingType: string;
  value: number | string;
};

export type AllocationMapping = {
  /** Optional exact (case-insensitive) security match. */
  security?: string;
  /** Optional exact (case-insensitive) holding type match. */
  holdingType?: string;
  assetClass: string;
};

export type AllocationTarget = { assetClass: string; target: number };

export type TargetValidation = {
  valid: boolean;
  total: number;
  difference: number;
  errors: string[];
};

export type AllocationRow = {
  assetClass: string;
  currentValue: number;
  currentPercentage: number;
  targetPercentage: number | null;
  targetValue: number | null;
  driftPercentagePoints: number | null;
  amountToTarget: number | null;
};

export type UnclassifiedHolding = HoldingRecord & { reason: "no_mapping" };

export type AllocationResult = {
  totalValue: number;
  classifiedValue: number;
  unclassifiedValue: number;
  allocations: AllocationRow[];
  unclassifiedHoldings: UnclassifiedHolding[];
  targetValidation: TargetValidation;
};

export type AllocationInput = {
  holdings: HoldingRecord[];
  mappings?: AllocationMapping[];
  targets?: AllocationTarget[] | Record<string, number>;
};

const EPSILON = 1e-6;

function numeric(value: number | string, label: string): number {
  const result = typeof value === "number" ? value : Number(String(value).replaceAll(",", "").trim());
  if (!Number.isFinite(result) || result < 0) throw new Error(`${label} must be a finite, non-negative number.`);
  return result;
}

function key(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function securityKey(security: HoldingRecord["security"]): string {
  if (typeof security === "string") return key(security);
  return key(security?.symbol ?? security?.id);
}

/** Validate that targets form a complete percentage allocation. */
export function validateAllocationTargets(targets: AllocationTarget[] | Record<string, number> = []): TargetValidation {
  const entries = Array.isArray(targets) ? targets : Object.entries(targets).map(([assetClass, target]) => ({ assetClass, target }));
  const values = entries.map((target) => target.target);
  const errors: string[] = [];
  let total = 0;
  entries.forEach(({ assetClass, target: value }, index) => {
    if (!String(assetClass ?? "").trim()) errors.push(`Target at index ${index} must name an asset class.`);
    if (!Number.isFinite(value) || value < 0) errors.push(`Target at index ${index} must be a finite, non-negative number.`);
    else total += value;
  });
  const difference = total - 100;
  if (Math.abs(difference) > EPSILON) errors.push(`Target percentages must sum to 100 (received ${total}).`);
  return { valid: errors.length === 0, total, difference, errors };
}

function targetRows(targets: AllocationInput["targets"]): AllocationTarget[] {
  if (!targets) return [];
  return Array.isArray(targets) ? targets : Object.entries(targets).map(([assetClass, target]) => ({ assetClass, target }));
}

function mappingFor(holding: HoldingRecord, mappings: AllocationMapping[]): string | null {
  const security = securityKey(holding.security);
  const type = key(holding.holdingType);
  const matches = mappings.filter((mapping) => {
    const hasSecurity = mapping.security !== undefined;
    const hasType = mapping.holdingType !== undefined;
    return (!hasSecurity || key(mapping.security) === security) && (!hasType || key(mapping.holdingType) === type) && (hasSecurity || hasType);
  });
  const match = matches.sort((a, b) => (Number(b.security !== undefined) + Number(b.holdingType !== undefined)) - (Number(a.security !== undefined) + Number(a.holdingType !== undefined)))[0];
  return match?.assetClass?.trim() || null;
}

/**
 * Calculate current allocation, drift and informational rebalance amounts.
 * `amountToTarget` is target value minus current value (positive means more
 * value would be needed); no trades are suggested or executed.
 */
export function calculateAllocation(input: AllocationInput): AllocationResult {
  const mappings = input.mappings ?? [];
  const targets = targetRows(input.targets);
  const targetValidation = validateAllocationTargets(targets);
  const targetByClass = new Map<string, number>();
  targets.forEach(({ assetClass, target }) => targetByClass.set(assetClass, (targetByClass.get(assetClass) ?? 0) + target));
  const values = new Map<string, number>();
  const unclassifiedHoldings: UnclassifiedHolding[] = [];
  let totalValue = 0;
  for (const holding of input.holdings) {
    const value = numeric(holding.value, "Holding value");
    totalValue += value;
    const assetClass = mappingFor(holding, mappings);
    if (!assetClass) unclassifiedHoldings.push({ ...holding, value, reason: "no_mapping" });
    else values.set(assetClass, (values.get(assetClass) ?? 0) + value);
  }
  const classes = new Set([...values.keys(), ...targetByClass.keys()]);
  const allocations = [...classes].map((assetClass): AllocationRow => {
    const currentValue = values.get(assetClass) ?? 0;
    const currentPercentage = totalValue === 0 ? 0 : currentValue / totalValue * 100;
    const targetPercentage = targetByClass.has(assetClass) ? targetByClass.get(assetClass)! : null;
    const targetValue = targetPercentage === null ? null : totalValue * targetPercentage / 100;
    return { assetClass, currentValue, currentPercentage, targetPercentage, targetValue, driftPercentagePoints: targetPercentage === null ? null : currentPercentage - targetPercentage, amountToTarget: targetValue === null ? null : targetValue - currentValue };
  });
  return { totalValue, classifiedValue: totalValue - unclassifiedHoldings.reduce((sum, holding) => sum + Number(holding.value), 0), unclassifiedValue: unclassifiedHoldings.reduce((sum, holding) => sum + Number(holding.value), 0), allocations, unclassifiedHoldings, targetValidation };
}

export const calculateAssetAllocation = calculateAllocation;
export const validateTargets = validateAllocationTargets;

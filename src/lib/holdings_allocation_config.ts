import type { AllocationMapping, AllocationTarget } from "$lib/allocation_service";

/** The only persisted state used by the local holdings allocation editor. */
export const HOLDINGS_ALLOCATION_STORAGE_KEY = "paisa:holdings-allocation:v1";

export type HoldingsAllocationConfig = {
  mappings: AllocationMapping[];
  targets: AllocationTarget[];
};

/** A small storage interface keeps this module usable in browser and tests. */
export interface AllocationConfigStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function emptyAllocationConfig(): HoldingsAllocationConfig {
  return { mappings: [], targets: [] };
}

/** Seed a new configuration from categories present in the imported holdings.
 *
 * Source categories are intentionally only a convenience default. The user can
 * change each mapping before relying on the report.
 */
export function defaultAllocationConfig(categories: string[]): HoldingsAllocationConfig {
  const unique = [...new Set(categories.map((category) => category.trim()).filter(Boolean))].sort();
  return {
    mappings: unique.map((holdingType) => ({ holdingType, assetClass: holdingType })),
    targets: []
  };
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function mappings(value: unknown): AllocationMapping[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): AllocationMapping[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const assetClass = text(item.assetClass);
    const holdingType = text(item.holdingType);
    const security = text(item.security);
    if (!assetClass || (!holdingType && !security)) return [];
    return [
      { assetClass, ...(holdingType ? { holdingType } : {}), ...(security ? { security } : {}) }
    ];
  });
}

function targets(value: unknown): AllocationTarget[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): AllocationTarget[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const assetClass = text(item.assetClass);
    const target =
      typeof item.target === "number"
        ? item.target
        : typeof item.target === "string" && item.target.trim() !== ""
          ? Number(item.target)
          : NaN;
    if (!assetClass || !Number.isFinite(target)) return [];
    return [{ assetClass, target }];
  });
}

/** Parse persisted data defensively; malformed local state falls back to empty. */
export function parseAllocationConfig(value: unknown): HoldingsAllocationConfig {
  if (!value || typeof value !== "object") return emptyAllocationConfig();
  const item = value as Record<string, unknown>;
  return { mappings: mappings(item.mappings), targets: targets(item.targets) };
}

export function loadAllocationConfig(
  storage: AllocationConfigStorage | undefined
): HoldingsAllocationConfig | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(HOLDINGS_ALLOCATION_STORAGE_KEY);
    if (!raw) return null;
    return parseAllocationConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveAllocationConfig(
  storage: AllocationConfigStorage | undefined,
  config: HoldingsAllocationConfig
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(HOLDINGS_ALLOCATION_STORAGE_KEY, JSON.stringify(parseAllocationConfig(config)));
    return true;
  } catch {
    return false;
  }
}

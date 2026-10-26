import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { HoldingRecord } from "./finance_reconciliation";

type KiteSnapshotManifest = {
  record_type: string;
  fetched_at: string;
  as_of_date: string;
  source_type: string;
  api_version: string;
  sync_version: string;
  content_sha256: string;
  counts?: { holdings?: number };
};

type KiteHolding = {
  tradingsymbol?: unknown;
  exchange?: unknown;
  isin?: unknown;
  quantity?: unknown;
  average_price?: unknown;
  last_price?: unknown;
};

type KiteSnapshot = {
  holdings?: unknown;
  positions?: unknown;
  margins?: unknown;
  orders?: unknown;
  trades?: unknown;
};

export type NormalizedKiteHolding = HoldingRecord & {
  record_type: "holding";
  source_id: string;
  units: string;
  average_price: string;
  nav: string;
  as_of_date: string;
  source: {
    import_id: string;
    original_path: string;
    content_sha256: string;
    record_locator: string;
  };
};

export type LatestKiteSnapshot = {
  fetched_at: string;
  as_of_date: string;
  content_sha256: string;
  holdings: NormalizedKiteHolding[];
};

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finite(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(String(value ?? ""));
  return Number.isFinite(number) ? number : null;
}

function decimal(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, "");
}

function validManifest(manifest: KiteSnapshotManifest, dateDirectory: string): boolean {
  return (
    manifest.record_type === "zerodha_kite_snapshot_manifest" &&
    manifest.source_type === "zerodha_kite_api" &&
    manifest.api_version === "3" &&
    /^\d{4}-\d{2}-\d{2}$/.test(manifest.as_of_date) &&
    manifest.as_of_date === dateDirectory &&
    !Number.isNaN(Date.parse(manifest.fetched_at)) &&
    /^[a-f0-9]{64}$/.test(manifest.content_sha256)
  );
}

function normalizeHolding(
  value: unknown,
  manifest: KiteSnapshotManifest
): NormalizedKiteHolding | null {
  if (!value || typeof value !== "object") return null;
  const holding = value as KiteHolding;
  const symbol = text(holding.tradingsymbol);
  const exchange = text(holding.exchange);
  const isin = text(holding.isin);
  const quantity = finite(holding.quantity);
  const averagePrice = finite(holding.average_price);
  const lastPrice = finite(holding.last_price);
  if (!symbol || !exchange || quantity === null || averagePrice === null || lastPrice === null)
    return null;
  const locator = `${exchange}:${symbol}`;
  const identifier = isin || locator;
  const originalPath = `api/zerodha/${manifest.as_of_date}`;
  return {
    record_type: "holding",
    source_id: sha256(`zerodha_kite_api\n${manifest.content_sha256}\n${locator}`),
    current_value: decimal(quantity * lastPrice),
    currency: "INR",
    units: decimal(quantity),
    average_price: decimal(averagePrice),
    nav: decimal(lastPrice),
    as_of_date: manifest.as_of_date,
    security: {
      identifier,
      ...(isin ? { isin } : {}),
      symbol,
      name: symbol,
      category: "Equity"
    },
    source: {
      import_id: manifest.content_sha256,
      original_path: originalPath,
      content_sha256: manifest.content_sha256,
      record_locator: locator
    }
  };
}

export function loadLatestZerodhaKiteSnapshot(
  root: string,
  issues: string[] = []
): LatestKiteSnapshot | null {
  const base = path.join(root, "extracted", "api", "zerodha");
  if (!existsSync(base)) return null;
  const candidates: LatestKiteSnapshot[] = [];
  for (const dateEntry of readdirSync(base, { withFileTypes: true })) {
    if (!dateEntry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(dateEntry.name)) continue;
    const datePath = path.join(base, dateEntry.name);
    for (const snapshotEntry of readdirSync(datePath, { withFileTypes: true })) {
      if (!snapshotEntry.isDirectory()) continue;
      const directory = path.join(datePath, snapshotEntry.name);
      try {
        const manifest = JSON.parse(
          readFileSync(path.join(directory, "manifest.json"), "utf8")
        ) as KiteSnapshotManifest;
        if (!validManifest(manifest, dateEntry.name)) throw new Error("invalid manifest");
        const bytes = readFileSync(path.join(directory, "snapshot.json"));
        if (sha256(bytes) !== manifest.content_sha256) throw new Error("snapshot hash mismatch");
        const snapshot = JSON.parse(bytes.toString("utf8")) as KiteSnapshot;
        if (!Array.isArray(snapshot.holdings)) throw new Error("invalid holdings");
        const holdings = snapshot.holdings.map((row) => normalizeHolding(row, manifest));
        if (holdings.some((row) => row === null)) throw new Error("invalid holding row");
        if (manifest.counts?.holdings !== undefined && manifest.counts.holdings !== holdings.length)
          throw new Error("holding count mismatch");
        candidates.push({
          fetched_at: manifest.fetched_at,
          as_of_date: manifest.as_of_date,
          content_sha256: manifest.content_sha256,
          holdings: holdings as NormalizedKiteHolding[]
        });
      } catch {
        issues.push("A Zerodha Kite API snapshot failed validation and was ignored.");
      }
    }
  }
  candidates.sort((left, right) =>
    left.fetched_at === right.fetched_at
      ? left.content_sha256.localeCompare(right.content_sha256)
      : left.fetched_at.localeCompare(right.fetched_at)
  );
  return candidates.at(-1) ?? null;
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadLatestZerodhaKiteSnapshot } from "./zerodha_kite_snapshot";

function writeSnapshot(root: string, fetchedAt: string, lastPrice: number, corrupt = false): void {
  const date = "2026-10-26";
  const directory = path.join(
    root,
    "extracted",
    "api",
    "zerodha",
    date,
    fetchedAt.replace(/[:.]/g, "-")
  );
  mkdirSync(directory, { recursive: true });
  const payload = `${JSON.stringify({
    holdings: [
      {
        tradingsymbol: "TEST",
        exchange: "NSE",
        isin: "INE000000001",
        quantity: 2,
        average_price: 10,
        last_price: lastPrice
      }
    ],
    positions: { net: [], day: [] },
    margins: {},
    orders: [],
    trades: []
  })}\n`;
  const digest = createHash("sha256").update(payload).digest("hex");
  writeFileSync(path.join(directory, "snapshot.json"), corrupt ? `${payload} ` : payload);
  writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      record_type: "zerodha_kite_snapshot_manifest",
      fetched_at: fetchedAt,
      as_of_date: date,
      source_type: "zerodha_kite_api",
      api_version: "3",
      sync_version: "1.0.0",
      content_sha256: digest,
      counts: { holdings: 1 }
    })
  );
}

test("loads only the newest hash-verified Kite snapshot", () => {
  const root = mkdtempSync(path.join(tmpdir(), "paisa-kite-snapshot-"));
  writeSnapshot(root, "2026-10-26T08:00:00Z", 12);
  writeSnapshot(root, "2026-10-26T09:00:00Z", 15);
  const issues: string[] = [];
  const result = loadLatestZerodhaKiteSnapshot(root, issues);
  assert.equal(result?.holdings.length, 1);
  assert.equal(result?.holdings[0].current_value, "30");
  assert.equal(result?.holdings[0].security?.identifier, "INE000000001");
  assert.equal(result?.holdings[0].source.original_path, "api/zerodha/2026-10-26");
  assert.deepEqual(issues, []);
});

test("rejects a Kite snapshot whose bytes do not match its manifest", () => {
  const root = mkdtempSync(path.join(tmpdir(), "paisa-kite-snapshot-"));
  writeSnapshot(root, "2026-10-26T08:00:00Z", 12, true);
  const issues: string[] = [];
  assert.equal(loadLatestZerodhaKiteSnapshot(root, issues), null);
  assert.equal(issues.length, 1);
});

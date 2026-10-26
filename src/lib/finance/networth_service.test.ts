import assert from "node:assert/strict";
import test from "node:test";
import { calculateNetWorth, type NetWorthHolding, type NetWorthManualBalance } from "./networth_service";

const source = (id: string) => ({ import_id: id, original_path: `fixture/${id}.json`, record_locator: "row:1" });
const holding = (id: string, value: string, date = "2026-08-31", key?: string): NetWorthHolding => ({ record_type: "holding", source_id: id, current_value: value, currency: "INR", as_of_date: date, source: source(id), overlap_key: key, security: { identifier: id } });
const manual = (id: string, type: "asset" | "liability", amount: string, date: string, importId = id): NetWorthManualBalance => ({ record_type: "manual_balance", source_id: id, balance_type: type, amount, currency: "INR", as_of_date: date, source: source(importId), label: id });

test("calculates dated assets, liabilities, net worth, and traceable lines", () => {
  const result = calculateNetWorth({ asOfDate: "2026-08-31", holdings: [holding("h-1", "100.25")], manualBalances: [manual("a-1", "asset", "50", "2026-08-01"), manual("l-1", "liability", "20.25", "2026-08-01")] });
  assert.equal(result.currencies.INR.assets, "150.25");
  assert.equal(result.currencies.INR.liabilities, "20.25");
  assert.equal(result.currencies.INR.netWorth, "130");
  assert.deepEqual(result.assets.map((row) => row.source_id), ["h-1", "a-1"]);
  assert.equal(result.liabilities[0].source.record_locator, "row:1");
});

test("uses latest labeled manual snapshot across imports and excludes unresolved overlaps", () => {
  const result = calculateNetWorth({ asOfDate: "2026-08-31", holdings: [holding("h-1", "100", "2026-08-31", "security:one"), holding("h-2", "110", "2026-08-31", "security:one")], manualBalances: [{ ...manual("old", "asset", "5", "2026-07-31", "snapshot-old"), label: "savings" }, { ...manual("new", "asset", "7", "2026-08-31", "snapshot-new"), label: "savings" }] });
  assert.equal(result.currencies.INR.assets, "7");
  assert.equal(result.overlaps.length, 1);
  assert.deepEqual(result.overlaps[0].record_ids, ["h-1", "h-2"]);
  assert.deepEqual(result.excludedRecordIds, ["h-1", "h-2"]);
  assert.equal(result.assets.some((row) => row.source_id === "old"), false);
  assert.equal(result.assets.some((row) => row.source_id === "new"), true);
  assert.equal(result.excludedRecords.every((row) => row.reason === "unresolved_overlap"), true);
});

test("keeps currencies separate and leaves undated holdings unresolved", () => {
  const result = calculateNetWorth({ asOfDate: "2026-08-31", holdings: [holding("h-1", "5", null as unknown as string)], manualBalances: [ { ...manual("usd", "asset", "3", "2026-08-01"), currency: "USD" } ] });
  assert.equal(result.assets.length, 1);
  assert.equal(result.currencies.USD.netWorth, "3");
  assert.equal(result.excludedRecords[0].reason, "missing_as_of_date");
});

test("uses the newer snapshot when CAS and Kuvera contain the same mutual-fund folio", () => {
  const cas = { ...holding("cas", "95", "2026-09-30"), security: { name: "Example Fund", identifier: "INF000000001:12345678" } };
  const kuvera = { ...holding("kuvera", "100", "2026-10-24"), security: { name: "Example Growth Direct Plan", identifier: "12345678/55" } };
  const result = calculateNetWorth({ asOfDate: "2026-10-25", holdings: [cas, kuvera] });
  assert.equal(result.currencies.INR.assets, "100");
  assert.deepEqual(result.assets.map((row) => row.source_id), ["kuvera"]);
  assert.deepEqual(result.excludedRecords, [{ source_id: "cas", reason: "superseded_overlap" }]);
});

test("uses newer CAS Meesho valuation instead of the manual Meesho estimate", () => {
  const cas = { ...holding("cas-meesho", "160", "2026-09-30"), security: { name: "MEESHO LIMITED # EQUITY SHARES", identifier: "INE0VDM01015" } };
  const converted = { ...holding("cas-meesho-zero", "0", "2026-09-30"), security: { name: "MEESHO LIMITED#NEW EQUITY SHARES", identifier: "IN80VDM01014" } };
  const estimate = { ...manual("manual-meesho", "asset", "130", "2026-08-01"), label: "ESOP Meesho (Excercised)", owner: "Shubham" };
  const result = calculateNetWorth({ asOfDate: "2026-10-25", holdings: [cas, converted], manualBalances: [estimate] });
  assert.equal(result.currencies.INR.assets, "160");
  assert.deepEqual(result.excludedRecords, [{ source_id: "manual-meesho", reason: "superseded_overlap" }]);
});

test("keeps same-labeled manual accounts separate by owner", () => {
  const shubham = { ...manual("ppf-1", "asset", "150", "2026-08-01"), label: "PPF", category: "Debt", owner: "Shubham" };
  const kirti = { ...manual("ppf-2", "asset", "720", "2026-08-01"), label: "PPF", category: "Debt", owner: "Kirti" };
  const result = calculateNetWorth({ asOfDate: "2026-10-25", manualBalances: [shubham, kirti] });
  assert.equal(result.currencies.INR.assets, "870");
  assert.equal(result.overlaps.length, 0);
});


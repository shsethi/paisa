import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importKuveraHoldingsFile, parseKuveraHoldingsCSV } from "./kuvera_holdings_csv";

const sourcePath = path.resolve("../My Finance/imports/investments/kuvera/kuvera_portfolio_holdings.csv");

test("parses supplied Kuvera holdings with normalized numeric strings and review metadata", () => {
  const parsed = parseKuveraHoldingsCSV(readFileSync(sourcePath));
  assert.equal(parsed.rows.length, 33);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.rows[0].security.name, "Canara Robeco Small Cap Growth Direct Plan");
  assert.equal(parsed.rows[0].security.identifier, "18840228202");
  assert.equal(parsed.rows[0].cost_basis, "14999");
  assert.equal(parsed.rows[0].current_value, "24794");
  assert.equal(parsed.rows.every((row) => row.currency === "INR" && row.as_of_date === null), true);
  assert.equal(parsed.rows.every((row) => row.review_status === "needs_review"), true);
});

test("rejects malformed rows while retaining valid rows", () => {
  const csv = [
    "Scheme Name,Category,Folio Number,Invested,Current Value,Units,NAV,Avg NAV,Total Returns,xirr",
    "Fund,Equity,F-1,100,110,2,55,50,10,8",
    "Broken,Equity,F-2,not-number,110,2,55,50,10,8",
  ].join("\n");
  const parsed = parseKuveraHoldingsCSV(csv);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.errors[0].record_locator, "csv row 3");
});

test("imports idempotently and retains source provenance without changing original", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kuvera-holdings-"));
  const imports = path.join(root, "imports", "investments", "kuvera");
  const contents = readFileSync(sourcePath);
  const source = path.join(imports, "holdings.csv");
  mkdirSync(imports, { recursive: true });
  writeFileSync(source, contents);
  const first = importKuveraHoldingsFile({ root, file: "investments/kuvera/holdings.csv", now: new Date("2026-10-24T00:00:00Z") });
  const second = importKuveraHoldingsFile({ root, file: "investments/kuvera/holdings.csv", now: new Date("2026-10-25T00:00:00Z") });
  assert.equal(first.status, "succeeded");
  assert.equal(first.row_counts.accepted, 33);
  assert.equal(second.already_imported, true);
  assert.equal(second.row_counts.accepted, 33);
  const dirs = requireDirectories(path.join(root, "extracted", "imports", "kuvera_holdings"));
  const output = JSON.parse(readFileSync(path.join(dirs[0], "holdings.json"), "utf8")) as Array<{ source: { original_path: string; record_locator: string } }>;
  assert.equal(output[0].source.original_path, "investments/kuvera/holdings.csv");
  assert.equal(output[0].source.record_locator, "csv row 2");
  assert.deepEqual(readFileSync(source), contents);
});

function requireDirectories(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(directory, entry.name));
}

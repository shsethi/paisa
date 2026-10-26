import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import * as XLSX from "xlsx";
import { importZerodhaPnlFile } from "./zerodha_pnl_import";
import { parseZerodhaPnl } from "./zerodha_pnl";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    [], [], ["Financial Year", "2025-26"], [], ["Short Term"],
    ["Symbol", "Buy Value", "Sell Value", "Profit"],
    ["SAFECO", 1000, 1200, 200],
  ]), "Equity and Non Equity");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Open Positions as of 2026-03-31"], ["Symbol", "Profit"], ["SAFECO", 10]]), "Open Positions as of 2026-03-31");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

test("parses realized gain rows with financial year and sheet/row provenance", () => {
  const result = parseZerodhaPnl(fixture());
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.records[0], {
    record_type: "zerodha_realized_gain_summary", financial_year: "2025-26", security: "SAFECO", gain_type: "short_term",
    buy_value: "1000.00", sell_value: "1200.00", realized_gain: "200.00", charges: null, currency: "INR",
    source: { sheet_name: "Equity and Non Equity", source_row: 7 },
  });
  assert.match(result.skipped_sheets.join(" "), /Open Positions/);
});

test("imports repeatably without duplicate output", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paisa-zerodha-pnl-")); roots.push(root);
  const sourceDir = path.join(root, "imports", "investments", "zerodha");
  const source = path.join(sourceDir, "fixture.xlsx");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(source, fixture());
  const digest = createHash("sha256").update(readFileSync(source)).digest("hex");
  const first = importZerodhaPnlFile({ root, file: "investments/zerodha/fixture.xlsx", now: new Date("2026-10-24T12:00:00Z") });
  assert.equal(first.status, "succeeded"); assert.equal(first.row_counts.accepted, 1); assert.equal(first.already_imported, false);
  const second = importZerodhaPnlFile({ root, file: "investments/zerodha/fixture.xlsx" });
  assert.equal(second.already_imported, true);
  const dirs = readdirSync(path.join(root, "extracted", "imports", "zerodha_pnl"));
  assert.equal(dirs.length, 1);
  const manifest = JSON.parse(readFileSync(path.join(root, "extracted", "imports", "zerodha_pnl", dirs[0], "manifest.json"), "utf8"));
  assert.equal(manifest.content_sha256, digest);
});


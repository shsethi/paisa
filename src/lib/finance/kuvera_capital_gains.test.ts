import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as XLSX from "xlsx";
import { importKuveraCapitalGainsFile } from "./kuvera_capital_gains_import";
import { parseKuveraCapitalGains } from "./kuvera_capital_gains";

const supplied = path.resolve("../My Finance/imports/investments/kuvera/shubham-Kuvera-CG_Report_2025-2026.xlsx");

function fixture(rows: unknown[][]): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Capital Gains Report");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

test("parses supplied workbook summaries with FY and sheet/row provenance", () => {
  const result = parseKuveraCapitalGains(readFileSync(supplied));
  assert.equal(result.records.length, 2);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.records.map((record) => ({ fy: record.financial_year, type: record.gain_type, row: record.source.source_row })), [
    { fy: "2025-26", type: "short_term", row: 8 },
    { fy: "2025-26", type: "long_term", row: 9 },
  ]);
});

test("normalizes populated summary amounts and rejects missing FY or amount", () => {
  const valid = parseKuveraCapitalGains(fixture([
    ["Statement Period", "FY 2024 - 25"],
    ["Short Term Capital Gains", "₹ 1,234.5"],
    ["Long Term Capital Gains", "(20)"],
  ]));
  assert.deepEqual(valid.records.map((record) => record.realized_gain), ["1234.50", "-20.00"]);
  const missing = parseKuveraCapitalGains(fixture([["Short Term Capital Gains", "not available"]])).errors;
  assert.deepEqual(missing.map((error) => error.code), ["missing_financial_year"]);
  const missingAmount = parseKuveraCapitalGains(fixture([["Statement Period", "FY 2024-25"], ["Long Term Capital Gains", ""]])).errors;
  assert.deepEqual(missingAmount.map((error) => error.code), ["missing_or_invalid_amount"]);
});

test("imports idempotently, preserves provenance, and leaves source unchanged", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kuvera-capital-gains-"));
  try {
    const sourceDir = path.join(root, "imports", "investments", "kuvera");
    const source = path.join(sourceDir, "gains.xlsx");
    const contents = fixture([["Statement Period", "FY 2024-25"], ["Short Term Capital Gains", 100]]);
    mkdirSync(sourceDir, { recursive: true }); writeFileSync(source, contents);
    const digest = createHash("sha256").update(contents).digest("hex");
    const first = importKuveraCapitalGainsFile({ root, file: "investments/kuvera/gains.xlsx", now: new Date("2026-10-24T00:00:00Z") });
    const second = importKuveraCapitalGainsFile({ root, file: "investments/kuvera/gains.xlsx" });
    assert.equal(first.status, "succeeded"); assert.equal(first.row_counts.accepted, 1); assert.equal(second.already_imported, true);
    const directory = readdirSync(path.join(root, "extracted", "imports", "kuvera_capital_gains"))[0];
    const manifest = JSON.parse(readFileSync(path.join(root, "extracted", "imports", "kuvera_capital_gains", directory, "manifest.json"), "utf8"));
    const records = JSON.parse(readFileSync(path.join(root, "extracted", "imports", "kuvera_capital_gains", directory, "records.json"), "utf8"));
    assert.equal(manifest.content_sha256, digest); assert.deepEqual(records[0].source, { sheet_name: "Capital Gains Report", source_row: 2 }); assert.deepEqual(readFileSync(source), contents);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

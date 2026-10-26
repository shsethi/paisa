import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importAnnualTaxStatement, parseAnnualTaxStatement } from "./annual_tax_statement";

const source = path.resolve("../My Finance/imports/tax/form-26as/ATS_FJUPS6108D_2026-27.xlsx");

test("parses the supplied tax statement withholding detail with sheet and row locators", async () => {
  const result = await parseAnnualTaxStatement(readFileSync(source), path.basename(source));
  assert.ok(result.records.length > 0);
  assert.equal(result.records.every((record) => record.financial_year === "2026-27" && record.currency === "INR"), true);
  assert.equal(result.records.every((record) => /!row:\d+$/.test(record.source.record_locator)), true);
  assert.equal(result.readRows, result.records.length + result.errors.length + result.skippedRows);
});

test("imports the workbook idempotently and preserves source bytes", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "annual-tax-statement-"));
  const directory = path.join(root, "imports", "tax", "form-26as");
  mkdirSync(directory, { recursive: true });
  const bytes = readFileSync(source);
  const target = path.join(directory, "ATS_2026-27.xlsx");
  writeFileSync(target, bytes);
  const options = { root, file: "tax/form-26as/ATS_2026-27.xlsx", now: new Date("2026-10-24T00:00:00Z") };
  const first = await importAnnualTaxStatement(options);
  const second = await importAnnualTaxStatement(options);
  assert.equal(first.status, "succeeded");
  assert.equal(second.already_imported, true);
  assert.equal(second.row_counts.accepted, first.row_counts.accepted);
  assert.deepEqual(readFileSync(target), bytes);
});

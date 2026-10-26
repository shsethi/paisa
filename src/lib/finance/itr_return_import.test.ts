import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importItrReturnFile } from "./itr_return_import";

const sample = JSON.stringify({ ITR: { ITR2: { Form_ITR2: { AssessmentYear: "2024" }, PartA_GEN1: { FilingStatus: { ReturnFileSec: 11 } }, "PartB-TI": { TotalIncome: 125 } } } });

test("imports JSON return with source provenance and idempotency", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "itr-return-")); const sourceDir = path.join(root, "imports", "tax", "returns"); mkdirSync(sourceDir, { recursive: true });
  const file = path.join(sourceDir, "return.json"); writeFileSync(file, sample);
  const options = { root, file: "tax/returns/return.json", now: new Date("2026-10-24T00:00:00Z") };
  const first = importItrReturnFile(options); const second = importItrReturnFile(options);
  assert.equal(first.status, "succeeded"); assert.equal(second.already_imported, true);
  const version = readdirSync(path.join(root, "extracted", "imports", "itr_returns"))[0];
  const record = JSON.parse(readFileSync(path.join(root, "extracted", "imports", "itr_returns", version, "return.json"), "utf8"));
  assert.equal(record.source.path, "tax/returns/return.json"); assert.equal(record.identity.assessmentYear.value, "2024-25");
});

test("retains revised return as distinct source version", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "itr-revised-")); const sourceDir = path.join(root, "imports", "tax", "returns"); mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(sourceDir, "return.json"), sample);
  writeFileSync(path.join(sourceDir, "return revised.json"), sample.replace('"ReturnFileSec":11', '"ReturnFileSec":17'));
  const first = importItrReturnFile({ root, file: "tax/returns/return.json" }); const second = importItrReturnFile({ root, file: "tax/returns/return revised.json" });
  assert.equal(first.status, "succeeded"); assert.equal(second.status, "succeeded");
  assert.equal(readdirSync(path.join(root, "extracted", "imports", "itr_returns")).length, 2);
});

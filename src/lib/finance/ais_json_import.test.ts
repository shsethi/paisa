import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importAisJsonFile } from "./ais_json_import";

const fixture = JSON.stringify({ AssessmentYear: "2026", TDS: [{ RecordId: "record-1", Nature: "Salary", Amount: 1000, TDSAmount: 100 }] });

test("imports plaintext AIS facts with local provenance and stable repeat behavior", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ais-json-")); const folder = path.join(root, "imports", "tax", "ais"); mkdirSync(folder, { recursive: true }); writeFileSync(path.join(folder, "ais.json"), fixture);
  const options = { root, file: "tax/ais/ais.json" }; const first = importAisJsonFile(options); const second = importAisJsonFile(options);
  assert.equal(first.status, "succeeded"); assert.equal(second.already_imported, true);
  const id = readdirSync(path.join(root, "extracted", "imports", "ais_json"))[0]; const stored = JSON.parse(readFileSync(path.join(root, "extracted", "imports", "ais_json", id, "facts.json"), "utf8"));
  assert.equal(stored.facts[0].sourcePath, "AIS.TDS[0]");
});

test("records a safe failed manifest for non-JSON source text", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ais-opaque-")); const folder = path.join(root, "imports", "tax", "ais"); mkdirSync(folder, { recursive: true }); writeFileSync(path.join(folder, "ais.json"), "not-json");
  const result = importAisJsonFile({ root, file: "tax/ais/ais.json" }); assert.equal(result.status, "failed"); assert.equal(result.row_counts.rejected, 1);
  const id = readdirSync(path.join(root, "extracted", "imports", "ais_json"))[0]; const manifest = readFileSync(path.join(root, "extracted", "imports", "ais_json", id, "manifest.json"), "utf8");
  assert.equal(manifest.includes("not-json"), false);
});

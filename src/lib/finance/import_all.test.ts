import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyImportFile, discoverImportCandidates } from "./import_all";

test("classifies every supported finance source family", () => {
  assert.equal(classifyImportFile("banking/icici/statement.xls"), "icici");
  assert.equal(classifyImportFile("banking/federal/statement.pdf"), "federal");
  assert.equal(classifyImportFile("investments/zerodha/tradebook.csv"), "zerodha_tradebook");
  assert.equal(classifyImportFile("investments/kuvera/portfolio_holdings.csv"), "kuvera_holdings");
  assert.equal(classifyImportFile("investments/indmoney/ORDER_REPORT.xls"), "indmoney_orders");
  assert.equal(classifyImportFile("investments/cas/NSDL-CAS.pdf"), "nsdl_cas");
  assert.equal(classifyImportFile("manual/assets-liabilities/snapshot.csv"), "manual_balances");
  assert.equal(classifyImportFile("tax/returns/return.xml"), "itr_return");
  assert.equal(classifyImportFile("tax/ais/ais.json"), "ais_json");
  assert.equal(classifyImportFile("tax/form-16/form16.pdf"), "form16");
  assert.equal(classifyImportFile("tax/form-26as/statement.xlsx"), "annual_tax_statement");
  assert.equal(classifyImportFile("investments/zerodha/archive/tradebook.csv"), null);
  assert.equal(classifyImportFile("banking/icici/statement.xlsx"), null);
});

test("discovers supported files, ignores inbox, and reports unsupported files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "finance-import-all-"));
  for (const directory of ["imports/_inbox", "imports/banking/icici", "imports/tax/ais"])
    mkdirSync(path.join(root, directory), { recursive: true });
  writeFileSync(path.join(root, "imports/_inbox/new.xls"), "pending");
  writeFileSync(path.join(root, "imports/banking/icici/statement.xls"), "source");
  writeFileSync(path.join(root, "imports/tax/ais/statement.pdf"), "unsupported");
  const result = discoverImportCandidates(root);
  assert.deepEqual(result.candidates, [{ kind: "icici", file: "banking/icici/statement.xls" }]);
  assert.deepEqual(result.unsupported, ["tax/ais/statement.pdf"]);
});

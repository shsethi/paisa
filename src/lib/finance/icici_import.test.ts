import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import * as XLSX from "xlsx";
import { importICICIFile } from "./icici_import";

const headers = [
  "Value Date",
  "Transaction Date",
  "Cheque Number",
  "Transaction Remarks",
  "Withdrawal Amount(INR)",
  "Deposit Amount(INR)",
  "Balance(INR)",
];

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "paisa-icici-"));
  roots.push(root);
  mkdirSync(path.join(root, "imports", "banking", "icici"), { recursive: true });
  return root;
}

function workbookBytes(amount = "125.00"): Buffer {
  const rows: unknown[][] = Array.from({ length: 12 }, () => []);
  rows.push([null, null, ...headers]);
  rows.push([
    null,
    null,
    "01/02/2026",
    "01/02/2026",
    null,
    "local fixture description",
    amount,
    "0.00",
    "875.00",
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(rows),
    "OpTransactionHistory",
  );
  return XLSX.write(workbook, { type: "buffer", bookType: "xls" }) as Buffer;
}

function writeSource(root: string, bytes: Buffer): Buffer {
  const source = path.join(root, "imports", "banking", "icici", "fixture.xls");
  writeFileSync(source, bytes);
  return Buffer.from(readFileSync(source));
}

function outputDirectories(root: string): string[] {
  const directory = path.join(root, "extracted", "imports", "icici");
  return readdirSync(directory).map((name) => path.join(directory, name));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ICICI import storage", () => {
  test("writes manifest and transactions, then skips an unchanged repeat", () => {
    const root = makeRoot();
    const original = writeSource(root, workbookBytes());
    const beforeHash = createHash("sha256").update(original).digest("hex");

    const first = importICICIFile({
      root,
      file: "banking/icici/fixture.xls",
      now: new Date("2026-10-24T12:00:00Z"),
    });
    assert.equal(first.status, "succeeded");
    assert.deepEqual(first.row_counts, { read: 1, accepted: 1, rejected: 0, skipped: 0 });
    assert.equal(first.already_imported, false);
    assert.equal(outputDirectories(root).length, 1);

    const directory = outputDirectories(root)[0];
    const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
    const transactions = JSON.parse(
      readFileSync(path.join(directory, "transactions.json"), "utf8"),
    );
    assert.equal(manifest.content_sha256, beforeHash);
    assert.equal(
      manifest.import_id,
      createHash("sha256")
        .update(`icici_bank_statement\nbanking/icici/fixture.xls\n${beforeHash}`)
        .digest("hex"),
    );
    assert.equal(manifest.row_counts.accepted, 1);
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0].source.original_path, "banking/icici/fixture.xls");
    assert.equal(statSync(path.join(directory, "manifest.json")).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(directory, "transactions.json")).mode & 0o777, 0o600);

    const repeat = importICICIFile({ root, file: "banking/icici/fixture.xls" });
    assert.equal(repeat.already_imported, true);
    assert.equal(outputDirectories(root).length, 1);
    assert.equal(createHash("sha256").update(readFileSync(path.join(root, "imports/banking/icici/fixture.xls"))).digest("hex"), beforeHash);
  });

  test("keeps a changed source version in a separate history directory", () => {
    const root = makeRoot();
    writeSource(root, workbookBytes("125.00"));
    importICICIFile({ root, file: "banking/icici/fixture.xls" });
    writeSource(root, workbookBytes("126.00"));
    const changed = importICICIFile({ root, file: "banking/icici/fixture.xls" });
    assert.equal(changed.status, "succeeded");
    assert.equal(changed.already_imported, false);
    assert.equal(outputDirectories(root).length, 2);
  });

  test("records a sanitized failure manifest when the workbook layout is unsupported", () => {
    const root = makeRoot();
    const broken = Buffer.from("not an Excel workbook");
    writeSource(root, broken);
    const result = importICICIFile({ root, file: "banking/icici/fixture.xls" });
    assert.equal(result.status, "failed");
    assert.equal(result.error_count, 1);
    assert.deepEqual(result.row_counts, { read: 0, accepted: 0, rejected: 0, skipped: 0 });
    const manifest = JSON.parse(
      readFileSync(path.join(outputDirectories(root)[0], "manifest.json"), "utf8"),
    );
    assert.equal(manifest.errors[0].code, "file_parse_failed");
    assert.equal(manifest.errors[0].message.includes("not an Excel workbook"), false);
  });

  test("dry-run returns counts without creating derived data", () => {
    const root = makeRoot();
    writeSource(root, workbookBytes());
    const result = importICICIFile({
      root,
      file: "banking/icici/fixture.xls",
      dryRun: true,
    });
    assert.equal(result.dry_run, true);
    assert.equal(result.row_counts.accepted, 1);
    assert.equal(readdirSync(path.join(root, "imports", "banking", "icici")).length, 1);
    assert.equal(existsSync(path.join(root, "extracted")), false);
  });
});

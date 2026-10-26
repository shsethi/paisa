import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import * as XLSX from "xlsx";
import { parseICICIXLS } from "./icici_xls";

const headers = [
  "Value Date",
  "Transaction Date",
  "Cheque Number",
  "Transaction Remarks",
  "Withdrawal Amount(INR)",
  "Deposit Amount(INR)",
  "Balance(INR)",
];

function workbookBuffer(rows: unknown[][]): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(rows),
    "OpTransactionHistory",
  );
  return XLSX.write(workbook, { type: "buffer", bookType: "xls" }) as Buffer;
}

describe("ICICI raw XLS parser", () => {
  test("preserves source row, blank cells, and raw values", () => {
    const rows = Array.from({ length: 12 }, () => [] as unknown[]);
    rows.push([null, null, ...headers]);
    rows.push([
      null,
      null,
      "01/02/2026",
      "02/02/2026",
      null,
      "  original description  ",
      "125.00",
      null,
      "875.00",
    ]);
    rows.push([]);
    rows.push([
      null,
      null,
      "03/02/2026",
      "03/02/2026",
      null,
      "second row",
      null,
      "25.50",
      "900.50",
    ]);

    const parsed = parseICICIXLS(workbookBuffer(rows));
    assert.equal(parsed.headerRow, 13);
    assert.equal(parsed.readRows, 3);
    assert.equal(parsed.skippedBlankRows, 1);
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.rows[0].sourceRow, 14);
    assert.equal(parsed.rows[0].transactionRemarks, "  original description  ");
    assert.equal(parsed.rows[0].withdrawalAmount, "125.00");
    assert.equal(parsed.rows[0].depositAmount, null);
    assert.equal(parsed.rows[1].sourceRow, 16);
    assert.equal(parsed.rows[1].depositAmount, "25.50");
  });

  test("rejects a workbook with missing required headers", () => {
    assert.throws(
      () => parseICICIXLS(workbookBuffer([headers.slice(0, 4)])),
      /required transaction headers not found on row 13/,
    );
  });

  const suppliedStatement = fileURLToPath(
    new URL(
      "../../../../My Finance/imports/banking/icici/icici24-10-2026.xls",
      import.meta.url,
    ),
  );
  test(
    "reads the supplied statement row count without asserting private cell values",
    { skip: !existsSync(suppliedStatement) },
    () => {
      const parsed = parseICICIXLS(suppliedStatement);
      assert.equal(parsed.headerRow, 13);
      assert.equal(parsed.rows.length, 62);
      assert.equal(parsed.skippedBlankRows, 28);
    },
  );
});

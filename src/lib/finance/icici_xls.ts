import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";

export const ICICI_XLS_PARSER_VERSION = "1.0.0";
export const ICICI_HEADER_ROW = 13;

const expectedHeaders = [
  "Value Date",
  "Transaction Date",
  "Cheque Number",
  "Transaction Remarks",
  "Withdrawal Amount(INR)",
  "Deposit Amount(INR)",
  "Balance(INR)",
];

const expectedSheetName = "OpTransactionHistory";
const columns = ["C", "D", "E", "F", "G", "H", "I"];

export type ICICIRawRow = {
  sourceRow: number;
  valueDate: unknown | null;
  transactionDate: unknown | null;
  chequeNumber: unknown | null;
  transactionRemarks: unknown | null;
  withdrawalAmount: unknown | null;
  depositAmount: unknown | null;
  balance: unknown | null;
};

export type ICICIRawParseResult = {
  sheetName: string;
  headerRow: number;
  readRows: number;
  skippedBlankRows: number;
  rows: ICICIRawRow[];
};

function cellValue(sheet: XLSX.WorkSheet, address: string): unknown | null {
  const cell = sheet[address];
  if (!cell || cell.v === undefined || cell.v === null || cell.v === "") {
    return null;
  }
  return cell.v;
}

function isHeaderAt(sheet: XLSX.WorkSheet, row: number): boolean {
  return expectedHeaders.every((header, index) => {
    const value = cellValue(sheet, `${columns[index]}${row}`);
    return typeof value === "string" && value.trim() === header;
  });
}

/** Read raw ICICI statement rows without normalizing or changing their cell values. */
export function parseICICIXLS(input: string | Buffer): ICICIRawParseResult {
  let workbook: XLSX.WorkBook;
  try {
    const data = typeof input === "string" ? readFileSync(input) : input;
    workbook = XLSX.read(data, { type: "buffer", raw: true, cellDates: false });
  } catch {
    throw new Error("ICICI workbook could not be read as an XLS workbook");
  }

  if (workbook.SheetNames.length !== 1) {
    throw new Error("Unexpected ICICI workbook layout: expected one worksheet");
  }

  const sheetName = workbook.SheetNames[0];
  if (sheetName !== expectedSheetName) {
    throw new Error(
      "Unexpected ICICI workbook layout: expected OpTransactionHistory worksheet",
    );
  }
  const sheet = workbook.Sheets[sheetName];
  if (!sheet || !sheet["!ref"]) {
    throw new Error("Unexpected ICICI workbook layout: worksheet is empty");
  }

  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const headerRows: number[] = [];
  for (let row = range.s.r + 1; row <= range.e.r + 1; row++) {
    if (isHeaderAt(sheet, row)) headerRows.push(row);
  }
  if (headerRows.length !== 1 || headerRows[0] !== ICICI_HEADER_ROW) {
    throw new Error(
      `Unexpected ICICI workbook layout: required transaction headers not found on row ${ICICI_HEADER_ROW}`,
    );
  }

  const headerRow = ICICI_HEADER_ROW;
  const rows: ICICIRawRow[] = [];
  let skippedBlankRows = 0;
  for (let row = headerRow + 1; row <= range.e.r + 1; row++) {
    const values = columns.map((column) => cellValue(sheet, `${column}${row}`));
    if (values.every((value) => value === null)) {
      skippedBlankRows++;
      continue;
    }
    rows.push({
      sourceRow: row,
      valueDate: values[0],
      transactionDate: values[1],
      chequeNumber: values[2],
      transactionRemarks: values[3],
      withdrawalAmount: values[4],
      depositAmount: values[5],
      balance: values[6],
    });
  }

  return {
    sheetName,
    headerRow,
    readRows: rows.length + skippedBlankRows,
    skippedBlankRows,
    rows,
  };
}

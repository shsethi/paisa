import Papa from "papaparse";

export const ZERODHA_TRADEBOOK_HEADERS = [
  "symbol",
  "isin",
  "trade_date",
  "exchange",
  "segment",
  "series",
  "trade_type",
  "auction",
  "quantity",
  "price",
  "trade_id",
  "order_id",
  "order_execution_time",
] as const;

export type ZerodhaTradebookRawRow = Record<(typeof ZERODHA_TRADEBOOK_HEADERS)[number], string> & {
  sourceRow: number;
  rowWidth: number;
};

export type ZerodhaTradebookParseResult = {
  rows: ZerodhaTradebookRawRow[];
  readRows: number;
  skippedBlankRows: number;
};

function isBlank(row: string[]): boolean {
  return row.every((value) => value.trim() === "");
}

export function parseZerodhaTradebookCSV(input: Buffer | string): ZerodhaTradebookParseResult {
  const text = typeof input === "string" ? input : input.toString("utf8");
  const parsed = Papa.parse<string[]>(text, { header: false, skipEmptyLines: false });
  const rows = parsed.data;
  if (rows.length === 0 || isBlank(rows[0] ?? [])) {
    throw new Error("Unexpected Zerodha tradebook CSV layout: header row is missing.");
  }
  const header = (rows[0] ?? []).map((value) => value.trim());
  if (header.length !== ZERODHA_TRADEBOOK_HEADERS.length ||
      header.some((value, index) => value !== ZERODHA_TRADEBOOK_HEADERS[index])) {
    throw new Error("Unexpected Zerodha tradebook CSV layout: unsupported headers.");
  }
  if (parsed.errors.length > 0 && parsed.errors.some((error) => error.code !== "TooFewFields")) {
    throw new Error("Unexpected Zerodha tradebook CSV syntax.");
  }
  const result: ZerodhaTradebookRawRow[] = [];
  let skippedBlankRows = 0;
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index] ?? [];
    if (isBlank(row)) {
      skippedBlankRows++;
      continue;
    }
    const record = Object.fromEntries(
      ZERODHA_TRADEBOOK_HEADERS.map((key, column) => [key, (row[column] ?? "").trim()]),
    ) as unknown as ZerodhaTradebookRawRow;
    record.sourceRow = index + 1;
    record.rowWidth = row.length;
    result.push(record);
  }
  return { rows: result, readRows: result.length, skippedBlankRows };
}

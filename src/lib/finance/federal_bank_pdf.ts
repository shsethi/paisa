import pdfjs from "pdfjs-dist/legacy/build/pdf.js";
import type { TextItem as PdfTextItem, TextMarkedContent } from "pdfjs-dist/types/src/display/api";

export type FederalBankRawRow = {
  transactionDate: string;
  description: string;
  withdrawalAmount: string;
  depositAmount: string;
  balance: string | null;
  page: number;
  sourceRow: number;
};

export type FederalBankParseResult = {
  readRows: number;
  skippedRows: number;
  rows: FederalBankRawRow[];
};

type TextItem = Pick<PdfTextItem, "str" | "transform">;

function isTextItem(item: PdfTextItem | TextMarkedContent): item is PdfTextItem {
  return "str" in item && typeof item.str === "string" && Array.isArray(item.transform);
}

function dateMatch(value: string): boolean {
  return /^\d{2}\/\d{2}\/\d{4}$/.test(value.trim());
}

function moneyInColumn(items: TextItem[], y: number, minX: number, maxX: number): string | null {
  const values = items
    .filter((item) => {
      const x = item.transform[4];
      return x >= minX && x < maxX && Math.abs(item.transform[5] - y) < 1.5;
    })
    .map((item) => item.str.trim())
    .filter(Boolean);
  return values.length === 0 ? null : values.join("").replaceAll(",", "");
}

function descriptionAt(items: TextItem[], y: number): string {
  const lines = new Map<number, TextItem[]>();
  for (const item of items) {
    const x = item.transform[4];
    const itemY = item.transform[5];
    if (x < 120 || x >= 232 || itemY > y + 1.5 || itemY < y - 13) continue;
    const lineY = Math.round(itemY * 2) / 2;
    const line = lines.get(lineY) ?? [];
    line.push(item);
    lines.set(lineY, line);
  }
  return [...lines.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, line]) =>
      line
        .sort((a, b) => a.transform[4] - b.transform[4])
        .map((item) => item.str)
        .join("")
    )
    .join("\n")
    .trim();
}

/** Parse the observed Federal Bank statement table using its PDF text positions. */
export async function parseFederalBankPDF(
  input: Buffer | Uint8Array,
  password?: string
): Promise<FederalBankParseResult> {
  let document: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
  try {
    // PDF.js copies its input when it needs to transfer bytes to the worker.
    const task = pdfjs.getDocument({
      data: Uint8Array.from(input),
      ...(password ? { password } : {})
    });
    document = await task.promise;
  } catch {
    throw new Error("PDF could not be unlocked or opened with the supplied password.");
  }

  const rows: FederalBankRawRow[] = [];
  let skippedRows = 0;
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items.filter(isTextItem);
      const hasFederalTable =
        items.some((item) => item.str.trim() === "Particulars") &&
        items.some((item) => item.str.trim() === "Withdrawal");
      if (!hasFederalTable) continue;

      const dateItems = items
        .filter((item) => item.transform[4] >= 20 && item.transform[4] < 80 && dateMatch(item.str))
        .sort((a, b) => b.transform[5] - a.transform[5]);
      let pageRow = 0;
      for (const dateItem of dateItems) {
        const y = dateItem.transform[5];
        const description = descriptionAt(items, y);
        pageRow++;
        const withdrawal = moneyInColumn(items, y, 345, 422);
        const deposit = moneyInColumn(items, y, 422, 481);
        const balance = moneyInColumn(items, y, 481, 540);
        rows.push({
          transactionDate: dateItem.str.trim(),
          description,
          withdrawalAmount: withdrawal ?? "",
          depositAmount: deposit ?? "",
          balance,
          page: pageNumber,
          sourceRow: pageRow
        });
      }
      // Opening balance and grand total are not dated transaction records.
      if (items.some((item) => item.str.trim() === "Opening Balance")) skippedRows++;
      if (items.some((item) => item.str.trim() === "GRAND TOTAL")) skippedRows++;
    }
  } catch {
    throw new Error(
      "PDF transaction table could not be read using the supported Federal Bank layout."
    );
  } finally {
    await document.destroy();
  }
  if (rows.length === 0) {
    throw new Error("Unexpected Federal Bank PDF layout: no dated transaction rows were found.");
  }
  return { readRows: rows.length + skippedRows, skippedRows, rows };
}

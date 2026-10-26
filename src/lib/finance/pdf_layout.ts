import pdfjs from "pdfjs-dist/legacy/build/pdf.js";
import type { TextItem as PdfTextItem, TextMarkedContent } from "pdfjs-dist/types/src/display/api";

export type PositionedText = { text: string; x: number; y: number; width: number; page: number };
export type VisualLine = { page: number; y: number; items: PositionedText[]; text: string };

function isTextItem(item: PdfTextItem | TextMarkedContent): item is PdfTextItem {
  return "str" in item && "transform" in item;
}

export async function extractVisualLines(input: Buffer, password?: string, tolerance = 1.5): Promise<VisualLine[]> {
  const task = pdfjs.getDocument({
    data: new Uint8Array(input),
    ...(password ? { password } : {}),
    standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/"
  });
  let document: Awaited<typeof task.promise>;
  try {
    document = await task.promise;
  } catch {
    throw new Error("PDF could not be opened with the supplied password.");
  }
  const output: VisualLine[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const rows: Array<{ y: number; items: PositionedText[] }> = [];
    for (const item of content.items.filter(isTextItem)) {
      const text = item.str.trim();
      if (!text) continue;
      const positioned = { text, x: item.transform[4], y: item.transform[5], width: item.width, page: pageNumber };
      let row = rows.find((candidate) => Math.abs(candidate.y - positioned.y) <= tolerance);
      if (!row) { row = { y: positioned.y, items: [] }; rows.push(row); }
      row.items.push(positioned);
    }
    rows.sort((a, b) => b.y - a.y);
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      output.push({ page: pageNumber, y: row.y, items: row.items, text: row.items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim() });
    }
  }
  return output;
}

export function decimalText(value: string): string | null {
  const cleaned = value.replace(/[₹,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : null;
}


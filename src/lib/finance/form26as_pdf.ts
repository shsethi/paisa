import { decimalText, extractVisualLines } from "./pdf_layout";

export const FORM26AS_PARSER_VERSION = "form26as-pdf/1";
export type Form26ASDeductorSummary = { serial_number: number; deductor_name: string; tan: string; amount_paid: string; tax_deducted: string; tax_deposited: string; source_page: number; record_locator: string };
export type Form26ASRecord = { record_type: "form26as_summary"; financial_year: string; assessment_year: string; deductors: Form26ASDeductorSummary[]; totals: { amount_paid: string; tax_deducted: string; tax_deposited: string } };

const tanPattern = /^[A-Z]{4}\d{5}[A-Z]$/;

export async function parseForm26ASPDF(input: Buffer): Promise<Form26ASRecord> {
  const lines = await extractVisualLines(input, undefined, 1.3);
  const joined = lines.map((line) => line.text).join("\n");
  if (!/(Form 26AS|Annual Tax Statement)/i.test(joined)) throw new Error("Unsupported Form 26AS PDF layout.");
  const fy = /Financial Year\s*(20\d{2}-\d{2})/i.exec(joined);
  const ay = /Assessment Year\s*(20\d{2}-\d{2})/i.exec(joined);
  if (!fy || !ay) throw new Error("Form 26AS year metadata could not be identified.");
  const deductors: Form26ASDeductorSummary[] = [];
  for (const line of lines) {
    const tanIndex = line.items.findIndex((item) => tanPattern.test(item.text));
    if (tanIndex < 1) continue;
    const serial = Number(line.items[0]?.text);
    const amounts = line.items.slice(tanIndex + 1).map((item) => decimalText(item.text)).filter((value): value is string => value !== null);
    if (!Number.isInteger(serial) || amounts.length < 3) continue;
    const name = line.items.slice(1, tanIndex).map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
    if (!name) continue;
    deductors.push({ serial_number: serial, deductor_name: name, tan: line.items[tanIndex].text, amount_paid: amounts.at(-3)!, tax_deducted: amounts.at(-2)!, tax_deposited: amounts.at(-1)!, source_page: line.page, record_locator: `page:${line.page}:y:${line.y.toFixed(1)}` });
  }
  const unique = [...new Map(deductors.map((record) => [`${record.tan}:${record.record_locator}`, record])).values()];
  const total = (key: "amount_paid" | "tax_deducted" | "tax_deposited") => unique.reduce((sum, record) => sum + Number(record[key]), 0).toFixed(2);
  return { record_type: "form26as_summary", financial_year: fy[1], assessment_year: ay[1], deductors: unique, totals: { amount_paid: total("amount_paid"), tax_deducted: total("tax_deducted"), tax_deposited: total("tax_deposited") } };
}


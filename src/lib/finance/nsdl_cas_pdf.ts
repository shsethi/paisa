import { decimalText, extractVisualLines, type VisualLine } from "./pdf_layout";

export const NSDL_CAS_PARSER_VERSION = "nsdl-cas-pdf/3";
export type NsdlCasHolding = { record_type: "holding"; source_id: string; security: { name: string; identifier: string; category: string }; units: string; cost_basis?: string; current_value: string; nav?: string; average_nav?: string; currency: "INR"; as_of_date: string; overlap_key: string; source: { import_id: string; original_path: string; content_sha256: string; record_locator: string }; review_status: "needs_review"; review_reasons: string[] };

const identifierPattern = /^IN[A-Z0-9]{10}$/;
const numberPattern = /-?[\d,]+(?:\.\d+)?/g;
const numeric = (text: string) => (text.match(numberPattern) ?? []).map(decimalText).filter((value): value is string => value !== null);
const isoDate = (text: string): string | null => { const match = /(\d{2})-([A-Za-z]{3})-(20\d{2})/.exec(text); if (!match) return null; const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(match[2].toLowerCase()) + 1; return month ? `${match[3]}-${String(month).padStart(2, "0")}-${match[1]}` : null; };

export function parseNsdlCasLines(lines: VisualLine[]): Array<Omit<NsdlCasHolding, "source_id" | "source"> & { record_locator: string }> {
  const allText = lines.map((line) => line.text).join("\n");
  if (!/Consolidated Account Statement/i.test(allText) || !/Mutual Fund Folios/i.test(allText)) throw new Error("Unsupported NSDL CAS layout.");
  const statementLine = lines.find((line) => /Statement for the period/i.test(line.text));
  const asOfDate = statementLine ? isoDate(statementLine.text.split(" to ").at(-1) ?? "") : null;
  if (!asOfDate) throw new Error("NSDL CAS statement date could not be identified.");
  const holdings: Array<Omit<NsdlCasHolding, "source_id" | "source"> & { record_locator: string }> = [];
  let category = "";
  for (const line of lines) {
    if (/^Equities \(E\)/i.test(line.text)) category = "equity";
    else if (/^Mutual Funds \(M\)/i.test(line.text)) category = "mutual_fund_demat";
    else if (/^Sovereign Gold Bonds/i.test(line.text)) category = "sovereign_gold_bond";
    else if (/^Mutual Fund Folios/i.test(line.text)) category = "mutual_fund_folio";
    const identifier = line.items.find((item) => identifierPattern.test(item.text))?.text;
    if (!identifier) continue;
    if (category !== "mutual_fund_folio") {
      const tail = line.text.slice(line.text.indexOf(identifier) + identifier.length).trim();
      const values = numeric(tail);
      if (values.length < 5) continue;
      const firstNumber = tail.search(/[\d,]+\.\d+/);
      let name = tail.slice(0, firstNumber).trim();
      if (!name) {
        name = lines.filter((candidate) => candidate.page === line.page && candidate.y > line.y && candidate.y-line.y < 12 && !/^[-\d,.\s]+$/.test(candidate.text) && !identifierPattern.test(candidate.items[0]?.text ?? "")).sort((a, b) => a.y-b.y)[0]?.text ?? "";
      }
      holdings.push({ record_type: "holding", security: { name: name || identifier, identifier, category }, units: values[0], current_value: values.at(-1)!, nav: values.at(-2), currency: "INR", as_of_date: asOfDate, overlap_key: `holding:${identifier}`.toLowerCase(), review_status: "needs_review", review_reasons: ["CAS may overlap with broker or fund-platform holdings; duplicate identifiers must be reviewed."], record_locator: `page:${line.page}:y:${line.y.toFixed(1)}` });
      continue;
    }
    const next = lines.find((candidate) => candidate.page === line.page && candidate.y < line.y && line.y - candidate.y < 8 && /^\d/.test(candidate.text));
    if (!next) continue;
    const values = numeric(next.text);
    if (values.length < 7) continue;
    const folio = next.text.split(/\s+/)[0];
    const name = line.text.slice(identifier.length).trim();
    holdings.push({ record_type: "holding", security: { name: name || identifier, identifier: `${identifier}:${folio}`, category }, units: values[1], average_nav: values[2], cost_basis: values[3], nav: values[4], current_value: values[5], currency: "INR", as_of_date: asOfDate, overlap_key: `holding:${identifier}`.toLowerCase(), review_status: "needs_review", review_reasons: ["CAS folio may overlap with Kuvera or another mutual-fund source; reconcile before including totals."], record_locator: `page:${line.page}:y:${line.y.toFixed(1)}` });
  }
  if (!holdings.length) throw new Error("NSDL CAS holdings tables were not found.");
  return holdings;
}

export async function parseNsdlCasPDF(input: Buffer, password: string) { return parseNsdlCasLines(await extractVisualLines(input, password, 1.2)); }


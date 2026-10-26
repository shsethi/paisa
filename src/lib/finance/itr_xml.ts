import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ItrAmount, SourceField } from "./itr_json";

export const ITR_XML_PARSER_VERSION = "itr-xml/1";

export type ItrXmlRecord = {
  source: { type: "itr-xml"; path?: string; contentHash: string; parserVersion: string };
  identity: {
    assessmentYear?: SourceField<string>;
    financialYear?: SourceField<string>;
    formName?: SourceField<string>;
    formVersion?: SourceField<string>;
    schemaVersion?: SourceField<string>;
    filingStatus?: SourceField<unknown>;
    returnFileSection?: SourceField<unknown>;
    regime?: SourceField<"new" | "old" | "unspecified">;
    filingVersion: "original" | "revised" | "unknown";
    versionKey: string;
  };
  incomeHeads: ItrAmount[];
  deductions: ItrAmount[];
  taxes: ItrAmount[];
  capitalGains: ItrAmount[];
  provenance: Record<string, string>;
  schemaNotes: string[];
};

type Field = { value: string; sourcePath: string };
type Fields = Map<string, Field>;

const asNumber = (v: string): number | undefined => {
  const n = Number(v.replace(/,/g, "").trim());
  return v.trim() !== "" && Number.isFinite(n) ? n : undefined;
};

// XML layouts use several prefixes (ITRForm, ns2, ns3, and ITR1FORM). Prefixes
// are transport details, so paths retain element names while removing prefixes.
function parseFields(xml: string): { fields: Fields; form: "ITR1" | "ITR2" | "ITR3" | "ITR4"; rootPath: string } {
  const fields: Fields = new Map();
  const stack: Array<{ name: string; path: string; text: string }> = [];
  const counts: Array<Map<string, number>> = [];
  let rootPath = "";
  let form: "ITR1" | "ITR2" | "ITR3" | "ITR4" | undefined;
  const tagRe = /<!--[\s\S]*?-->|<\?[^>]*\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?\s*([A-Za-z_][\w:.-]*)(?:\s[^>]*)?\/?>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(xml))) {
    const token = match[0];
    if (token.startsWith("<!--") || token.startsWith("<?") || token.startsWith("<![")) continue;
    if (match[2] !== undefined) {
      const text = match[2].trim();
      if (text && stack.length) stack[stack.length - 1].text += `${stack[stack.length - 1].text ? " " : ""}${text}`;
      continue;
    }
    const rawName = match[1];
    const name = rawName.includes(":") ? rawName.slice(rawName.lastIndexOf(":") + 1) : rawName;
    const closing = /^<\//.test(token);
    const selfClosing = /\/\s*>$/.test(token);
    if (closing) {
      const node = stack.pop(); counts.pop();
      if (!node) throw new Error("Unsupported ITR XML: malformed closing tag");
      const value = node.text.trim();
      if (value && !fields.has(node.path)) fields.set(node.path, { value, sourcePath: node.path });
      if (stack.length && value) stack[stack.length - 1].text += `${stack[stack.length - 1].text ? " " : ""}${value}`;
      continue;
    }
    const parent = stack[stack.length - 1];
    const parentCounts = counts[counts.length - 1];
    const index = parentCounts?.get(name) ?? 0;
    if (parentCounts) parentCounts.set(name, index + 1);
    const path = parent ? `${parent.path}.${name}${index ? `[${index}]` : ""}` : name;
    if (!parent) rootPath = path;
    if (name === "ITR1" || name === "ITR2" || name === "ITR3" || name === "ITR4") form = name;
    if (!selfClosing) {
      stack.push({ name, path, text: "" });
      counts.push(new Map());
    }
  }
  if (!form) throw new Error("Unsupported ITR XML: missing supported ITR form (ITR1/2/3/4)");
  return { fields, form, rootPath };
}

const first = (fields: Fields, paths: string[]): Field | undefined => {
  for (const path of paths) {
    const exact = fields.get(path);
    if (exact) return exact;
    // Repeated XML nodes are indexed after the first occurrence.
    const repeated = [...fields.entries()].find(([p, f]) => p.startsWith(`${path}[`) && f.value !== "");
    if (repeated) return repeated[1];
  }
  return undefined;
};

function amount(fields: Fields, key: string, paths: string[]): ItrAmount | undefined {
  const field = first(fields, paths); const value = field && asNumber(field.value);
  return field && value !== undefined ? { key, value, sourcePath: field.sourcePath } : undefined;
}
function amounts(fields: Fields, specs: Array<[string, string[]]>): ItrAmount[] {
  return specs.map(([key, paths]) => amount(fields, key, paths)).filter((x): x is ItrAmount => !!x);
}
function path(root: string, suffix: string): string { return `${root}.${suffix}`; }

export function parseItrXml(input: string, sourcePath?: string): ItrXmlRecord {
  if (typeof input !== "string" || !input.trim()) throw new Error("Unsupported ITR XML: empty document");
  const { fields, form } = parseFields(input);
  const root = `ITR.${form}`;
  const p = (suffix: string) => path(root, suffix);
  const formInfo = first(fields, [p(`Form_${form}`), p(`Form_ITR${form.slice(-1)}`)]);
  const assessment = first(fields, [p(`Form_${form}.AssessmentYear`), p(`Form_ITR${form.slice(-1)}.AssessmentYear`)]);
  const filing = first(fields, [p("FilingStatus.ReturnFileSec"), p("PartA_GEN1.FilingStatus.ReturnFileSec")]);
  const status = first(fields, [p("PersonalInfo.Status"), p("PartA_GEN1.PersonalInfo.Status")]);
  const rawAy = assessment?.value;
  const ay = rawAy && /^\d{4}$/.test(rawAy) ? `${rawAy}-${String((Number(rawAy) + 1) % 100).padStart(2, "0")}` : rawAy;
  const revision = /revis|updated/i.test(`${sourcePath ?? ""} ${filing?.value ?? ""}`) || filing?.value === "17";
  const newRegime = first(fields, [p("FilingStatus.NewTaxRegime"), p("PartA_GEN1.FilingStatus.NewTaxRegime")]);
  const optOut = first(fields, [p("FilingStatus.OptOutNewTaxRegime"), p("PartA_GEN1.FilingStatus.OptOutNewTaxRegime")]);
  const regime: SourceField<"new" | "old" | "unspecified"> = newRegime && /^(Y|true|1)$/i.test(newRegime.value)
    ? { value: "new", sourcePath: newRegime.sourcePath }
    : optOut && /^(Y|true|1)$/i.test(optOut.value) ? { value: "old", sourcePath: optOut.sourcePath } : { value: "unspecified", sourcePath: "" };
  const contentHash = createHash("sha256").update(input).digest("hex");
  const identity: ItrXmlRecord["identity"] = {
    assessmentYear: ay && assessment ? { value: ay, sourcePath: assessment.sourcePath } : undefined,
    financialYear: ay && /^\d{4}-\d{2}$/.test(ay) ? { value: `${Number(ay.slice(0, 4)) - 1}-${String(Number(ay.slice(0, 4)) % 100).padStart(2, "0")}`, sourcePath: assessment?.sourcePath ?? "" } : undefined,
    formName: formInfo ? first(fields, [`${formInfo.sourcePath}.FormName`]) : first(fields, [p("Form_ITR1.FormName"), p("Form_ITR2.FormName")]),
    formVersion: formInfo ? first(fields, [`${formInfo.sourcePath}.FormVer`]) : undefined,
    schemaVersion: formInfo ? first(fields, [`${formInfo.sourcePath}.SchemaVer`]) : undefined,
    filingStatus: status, returnFileSection: filing, regime,
    filingVersion: revision ? "revised" : sourcePath ? "original" : "unknown",
    versionKey: `${ay ?? "unknown"}:${filing?.value ?? "unknown"}:${status?.value ?? "unknown"}:${contentHash.slice(0, 16)}`,
  };
  const incomeHeads = amounts(fields, [
    ["salary", [p("ITR1_IncomeDeductions.Salary"), p("ITR1_IncomeDeductions.NetSalary"), p("PartB-TI.Salaries"), p("ScheduleS.Salaries.Salarys.Salary"), p("ScheduleS.Salaries.TotIncUnderHeadSalaries")]],
    ["houseProperty", [p("ITR1_IncomeDeductions.TotalIncomeOfHP"), p("PartB-TI.IncomeFromHP"), p("ScheduleHP.TotalIncomeChargeableUnHP")]],
    ["shortTermCapitalGains", [p("PartB-TI.CapGain.ShortTerm.TotalShortTerm"), p("ScheduleCGFor23.ShortTermCapGainFor23.TotalSTCG")]],
    ["longTermCapitalGains", [p("PartB-TI.CapGain.LongTerm.TotalLongTerm"), p("ScheduleCGFor23.LongTermCapGain23.TotalLTCG")]],
    ["capitalGains", [p("PartB-TI.CapGain.TotalCapGains"), p("PartB-TI.TotalCapGains"), p("ScheduleCGFor23.TotScheduleCGFor23")]],
    ["otherSources", [p("PartB-TI.IncFromOS.TotIncFromOS"), p("ITR1_IncomeDeductions.IncomeFromOthSources")]],
    ["totalIncome", [p("PartB-TI.TotalIncome"), p("ITR1_IncomeDeductions.TotalIncome"), p("ITR1_IncomeDeductions.GrossTotIncome"), p("PartB-TI.GrossTotalIncome")]],
  ]);
  const deductions = amounts(fields, [["chapterVIA", [p("PartB-TI.DeductionsUnderScheduleVIA"), p("ScheduleVIA.UsrDeductUndChapVIA.TotalChapVIADeductions"), p("ITR1_IncomeDeductions.UsrDeductUndChapVIA.TotalChapVIADeductions")]], ["section80C", [p("ScheduleVIA.UsrDeductUndChapVIA.Section80C"), p("ScheduleVIA.DeductUndChapVIA.Section80C")]], ["section80D", [p("ScheduleVIA.UsrDeductUndChapVIA.Section80D"), p("ScheduleVIA.DeductUndChapVIA.Section80D")]], ["section80CCD1B", [p("ScheduleVIA.UsrDeductUndChapVIA.Section80CCD1B"), p("ScheduleVIA.DeductUndChapVIA.Section80CCD1B")]]]);
  const taxes = amounts(fields, [["grossTaxLiability", [p("ITR1_TaxComputation.GrossTaxLiability"), p("PartB_TTI.ComputationOfTaxLiability.GrossTaxLiability")]], ["netTaxLiability", [p("ITR1_TaxComputation.NetTaxLiability"), p("PartB_TTI.ComputationOfTaxLiability.NetTaxLiability")]], ["totalTaxesPaid", [p("TaxPaid.TaxesPaid.TotalTaxesPaid"), p("ITR1_TaxComputation.TotalTaxesPaid"), p("PartB_TTI.TaxPaid.TaxesPaid.TotalTaxesPaid")]], ["tds", [p("TDSonSalaries.TotalTDSonSalaries"), p("ScheduleTDS1.TotalTDSonSalaries")]], ["advanceTax", [p("TaxPaid.TaxesPaid.AdvanceTax"), p("PartB_TTI.TaxPaid.TaxesPaid.AdvanceTax")]], ["selfAssessmentTax", [p("TaxPaid.TaxesPaid.SelfAssessmentTax"), p("PartB_TTI.TaxPaid.TaxesPaid.SelfAssessmentTax")]], ["taxPayable", [p("TaxPaid.BalTaxPayable"), p("PartB_TTI.TaxPaid.BalTaxPayable")]], ["refundDue", [p("Refund.RefundDue"), p("PartB_TTI.Refund.RefundDue")]]]);
  const capitalGains = amounts(fields, [["scheduleTotal", [p("ScheduleCGFor23.TotScheduleCGFor23")]], ["scheduleSTCG", [p("ScheduleCGFor23.ShortTermCapGainFor23.TotalSTCG")]], ["scheduleLTCG", [p("ScheduleCGFor23.LongTermCapGain23.TotalLTCG")]], ["vda", [p("ScheduleCGFor23.IncmFromVDATrnsf")]]]);
  const provenance: Record<string, string> = {};
  for (const group of [incomeHeads, deductions, taxes, capitalGains]) for (const item of group) provenance[item.key] = item.sourcePath;
  if (regime.sourcePath) provenance.regime = regime.sourcePath;
  return { source: { type: "itr-xml", ...(sourcePath ? { path: sourcePath } : {}), contentHash, parserVersion: ITR_XML_PARSER_VERSION }, identity, incomeHeads, deductions, taxes, capitalGains, provenance, schemaNotes: ["Observed ITR1 and ITR2 XML layouts; unsupported fields are omitted, never inferred.", "XML namespace prefixes are removed from source paths while element names and repeated-node indexes are retained.", "Filing version is revised only when source path or ReturnFileSec explicitly identifies a revision."] };
}

export async function parseItrXmlFile(path: string): Promise<ItrXmlRecord> { return parseItrXml(await readFile(path, "utf8"), path); }

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const ITR_JSON_PARSER_VERSION = "itr-json/1";

export type SourceField<T = unknown> = { value: T; sourcePath: string };
export type ItrAmount = SourceField<number> & { key: string };

export type ItrJsonRecord = {
  source: { type: "itr-json"; path?: string; contentHash: string; parserVersion: string };
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

type Json = Record<string, any>;

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const first = (root: Json, paths: string[]): SourceField | undefined => {
  for (const sourcePath of paths) {
    const value = sourcePath.split(".").reduce((v, key) => (isObj(v) ? v[key] : undefined), root as any);
    if (value !== undefined && value !== null && value !== "") return { value, sourcePath };
  }
  return undefined;
};

const asString = (v: unknown): string | undefined => {
  if (typeof v === "string" || typeof v === "number") return String(v);
  return undefined;
};
const asNumber = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.replace(/,/g, "")))) return Number(v.replace(/,/g, ""));
  return undefined;
};

function amount(root: Json, key: string, paths: string[]): ItrAmount | undefined {
  const f = first(root, paths); const n = f && asNumber(f.value);
  return f && n !== undefined ? { key, value: n, sourcePath: f.sourcePath } : undefined;
}
function amounts(root: Json, specs: Array<[string, string[]]>): ItrAmount[] {
  return specs.map(([key, paths]) => amount(root, key, paths)).filter((x): x is ItrAmount => !!x);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObj(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function parseItrJson(input: string | Json, sourcePath?: string): ItrJsonRecord {
  let root: Json;
  let raw: string;
  if (typeof input === "string") { raw = input; root = JSON.parse(input); }
  else { root = input; raw = canonicalJson(input); }
  if (!isObj(root) || !isObj(root.ITR)) throw new Error("Unsupported ITR JSON: missing ITR envelope");
  const base = root.ITR.ITR2 ?? root.ITR.ITR1 ?? root.ITR.ITR3 ?? root.ITR.ITR4;
  if (!isObj(base)) throw new Error("Unsupported ITR JSON: missing supported ITR form (ITR1/2/3/4)");
  const doc: Json = { ITR: { ITR2: base } };
  const p = (path: string) => `ITR.ITR2.${path}`;
  const assessment = first(doc, [p("Form_ITR2.AssessmentYear")]);
  const filing = first(doc, [p("PartA_GEN1.FilingStatus.ReturnFileSec")]);
  const status = first(doc, [p("PartA_GEN1.PersonalInfo.Status")]);
  const optOut = first(doc, [p("PartA_GEN1.FilingStatus.OptOutNewTaxRegime")]);
  const newRegime = first(doc, [p("PartA_GEN1.FilingStatus.NewTaxRegime")]);
  const regime: SourceField<"new" | "old" | "unspecified"> = newRegime?.value === "Y" || newRegime?.value === true
    ? { value: "new", sourcePath: newRegime.sourcePath }
    : optOut?.value === "Y" || optOut?.value === true ? { value: "old", sourcePath: optOut.sourcePath } : { value: "unspecified", sourcePath: "" };
  const rawAy = asString(assessment?.value);
  // The portal uses both "2024" and "2024-25" for AY 2024-25 across observed versions.
  const ay = rawAy && /^\d{4}$/.test(rawAy) ? `${rawAy}-${String((Number(rawAy) + 1) % 100).padStart(2, "0")}` : rawAy;
  const identity: ItrJsonRecord["identity"] = {
    assessmentYear: assessment && ay ? { value: ay, sourcePath: assessment.sourcePath } : undefined,
    financialYear: assessment && ay && /^\d{4}-\d{2}$/.test(ay) ? { value: `${Number(ay.slice(0, 4)) - 1}-${String(Number(ay.slice(0, 4)) % 100).padStart(2, "0")}`, sourcePath: assessment.sourcePath } : undefined,
    formName: first(doc, [p("Form_ITR2.FormName")]) as SourceField<string> | undefined,
    formVersion: first(doc, [p("Form_ITR2.FormVer")]) as SourceField<string> | undefined,
    schemaVersion: first(doc, [p("Form_ITR2.SchemaVer")]) as SourceField<string> | undefined,
    filingStatus: status,
    returnFileSection: filing,
    regime,
    filingVersion: /revis|updated/i.test(`${status?.value ?? ""} ${filing?.value ?? ""} ${sourcePath ?? ""}`) ? "revised" : "unknown",
    versionKey: `${ay ?? "unknown"}:${filing?.value ?? "unknown"}:${status?.value ?? "unknown"}:${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`,
  };
  const incomeHeads = amounts(doc, [
    ["salary", [p("PartB-TI.Salaries"), p("ScheduleS.TotIncUnderHeadSalaries")]],
    ["houseProperty", [p("PartB-TI.IncomeFromHP"), p("ScheduleHP.TotalIncomeChargeableUnHP")]],
    ["shortTermCapitalGains", [p("PartB-TI.CapGain.ShortTerm.TotalShortTerm")]],
    ["longTermCapitalGains", [p("PartB-TI.CapGain.LongTerm.TotalLongTerm")]],
    ["capitalGains", [p("PartB-TI.CapGain.TotalCapGains"), p("ScheduleCGFor23.TotScheduleCGFor23")]],
    ["otherSources", [p("PartB-TI.IncFromOS.TotIncFromOS")]],
    ["totalIncome", [p("PartB-TI.TotalIncome"), p("PartB-TI.GrossTotalIncome")]],
  ]);
  const deductions = amounts(doc, [
    ["chapterVIA", [p("PartB-TI.DeductionsUnderScheduleVIA"), p("ScheduleVIA.UsrDeductUndChapVIA.TotalChapVIADeductions"), p("ScheduleVIA.DeductUndChapVIA.TotalChapVIADeductions")]],
    ["section80C", [p("ScheduleVIA.UsrDeductUndChapVIA.Section80C"), p("ScheduleVIA.DeductUndChapVIA.Section80C")]],
    ["section80D", [p("ScheduleVIA.UsrDeductUndChapVIA.Section80D"), p("ScheduleVIA.DeductUndChapVIA.Section80D")]],
    ["section80CCD1B", [p("ScheduleVIA.UsrDeductUndChapVIA.Section80CCD1B"), p("ScheduleVIA.DeductUndChapVIA.Section80CCD1B")]],
  ]);
  const taxes = amounts(doc, [
    ["grossTaxLiability", [p("PartB_TTI.ComputationOfTaxLiability.GrossTaxLiability")]],
    ["netTaxLiability", [p("PartB_TTI.ComputationOfTaxLiability.NetTaxLiability")]],
    ["totalTaxesPaid", [p("PartB_TTI.TaxPaid.TaxesPaid.TotalTaxesPaid")]],
    ["tds", [p("PartB_TTI.TaxPaid.TaxesPaid.TDS"), p("ScheduleTDS1.TotalTDSonSalaries")]],
    ["advanceTax", [p("PartB_TTI.TaxPaid.TaxesPaid.AdvanceTax")]],
    ["selfAssessmentTax", [p("PartB_TTI.TaxPaid.TaxesPaid.SelfAssessmentTax")]],
    ["taxPayable", [p("PartB_TTI.TaxPaid.BalTaxPayable")]],
    ["refundDue", [p("PartB_TTI.Refund.RefundDue")]],
  ]);
  const capitalGains = amounts(doc, [
    ["scheduleTotal", [p("ScheduleCGFor23.TotScheduleCGFor23")]],
    ["scheduleSTCG", [p("ScheduleCGFor23.ShortTermCapGainFor23.TotalSTCG")]],
    ["scheduleLTCG", [p("ScheduleCGFor23.LongTermCapGain23.TotalLTCG")]],
    ["vda", [p("ScheduleCGFor23.IncmFromVDATrnsf")]],
  ]);
  const provenance: Record<string, string> = {};
  for (const group of [incomeHeads, deductions, taxes, capitalGains]) for (const x of group) provenance[`${x.key}`] = x.sourcePath;
  if (regime.sourcePath) provenance.regime = regime.sourcePath;
  const contentHash = createHash("sha256").update(raw).digest("hex");
  identity.versionKey = `${ay ?? "unknown"}:${filing?.value ?? "unknown"}:${status?.value ?? "unknown"}:${contentHash.slice(0, 16)}`;
  return { source: { type: "itr-json", ...(sourcePath ? { path: sourcePath } : {}), contentHash, parserVersion: ITR_JSON_PARSER_VERSION }, identity, incomeHeads, deductions, taxes, capitalGains, provenance, schemaNotes: ["Observed ITR2 JSON layouts; unsupported fields are omitted, never inferred.", "Filing version is revised only when source path or filing fields explicitly identify a revision."] };
}

export async function parseItrJsonFile(path: string): Promise<ItrJsonRecord> { return parseItrJson(await readFile(path, "utf8"), path); }

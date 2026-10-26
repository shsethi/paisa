import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { readFile } from "node:fs/promises";

export const AIS_JSON_PARSER_VERSION = "ais-json/1";

/**
 * Decrypt the encrypted JSON downloaded for the Income Tax Department's AIS
 * utility. The envelope is: 16-byte IV as hex, 16-byte salt as hex, then
 * Base64 AES-256-CBC ciphertext. The supplied password is never persisted.
 */
export function decryptAisUtilityJson(input: string | Buffer, password: string): string {
  const payload = (Buffer.isBuffer(input) ? input.toString("utf8") : input).trim();
  if (!password) throw new Error("An AIS JSON password is required.");
  if (payload.length < 96 || !/^[0-9a-fA-F]{64}/.test(payload)) {
    throw new Error("AIS JSON does not have the expected encrypted utility format.");
  }

  const iv = Buffer.from(payload.slice(0, 32), "hex");
  const salt = Buffer.from(payload.slice(32, 64), "hex");
  const encrypted = payload.slice(64).replace(/\s/g, "");
  if (iv.length !== 16 || salt.length !== 16 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) {
    throw new Error("AIS JSON has an invalid encrypted utility envelope.");
  }

  // The portal's PDF password is normally lowercase PAN + DOB. The AIS
  // utility derives its key from that base value with this utility component
  // inserted before the final DDMMYYYY. Keep the literal password first so
  // this also supports a future portal-provided password without guessing.
  const utilityPassword = /^[a-z]{5}\d{4}[a-z]\d{8}$/i.test(password)
    ? `${password.slice(0, -8)}GQ39%*g${password.slice(-8)}`
    : undefined;
  for (const candidate of [password, utilityPassword].filter((value): value is string => Boolean(value))) {
    try {
      const key = pbkdf2Sync(candidate, salt, 1000, 32, "sha256");
      const decipher = createDecipheriv("aes-256-cbc", key, iv);
      const plaintext = Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
      JSON.parse(plaintext);
      return plaintext;
    } catch {
      // Try the utility-derived password next, without revealing which form
      // was accepted or including the password in an error.
    }
  }
  throw new Error("AIS JSON could not be decrypted with the supplied password.");
}
export type SourceField<T = unknown> = { value: T; sourcePath: string };

export type AisFact = {
  recordId: string;
  section: string;
  category: "income" | "tax" | "transaction" | "other";
  description?: SourceField<string>;
  date?: SourceField<string>;
  amount?: SourceField<number>;
  taxDeducted?: SourceField<number>;
  taxCollected?: SourceField<number>;
  sourcePath: string;
};

export type AisJsonRecord = {
  source: { type: "ais-json"; path?: string; contentHash: string; parserVersion: string };
  identity: { assessmentYear?: SourceField<string>; financialYear?: SourceField<string>; versionKey: string };
  facts: AisFact[];
  provenance: Record<string, string>;
  schemaNotes: string[];
};

type Json = Record<string, any>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const asString = (v: unknown) => typeof v === "string" || typeof v === "number" ? String(v) : undefined;
const asNumber = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v.replace(/,/g, "")))) return Number(v.replace(/,/g, ""));
  return undefined;
};
const canonicalJson = (v: any): string => Array.isArray(v) ? `[${v.map(canonicalJson).join(",")}]` : isObj(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}` : JSON.stringify(v);
const findField = (obj: Json, names: RegExp): SourceField | undefined => {
  for (const [key, value] of Object.entries(obj)) if (names.test(key) && value !== null && value !== "") return { value, sourcePath: key };
  return undefined;
};
const sectionOf = (path: string, key: string) => path.split(".").filter(Boolean).slice(0, -1).join(".") || key;

function utilityTableFacts(root: Json): AisFact[] {
  const sections = root.partB?.sections;
  if (!Array.isArray(sections)) return [];
  const facts: AisFact[] = [];
  const toRows = (table: any) => {
    if (!isObj(table) || !Array.isArray(table.columnLabel) || !Array.isArray(table.columnData)) return [];
    const labels = table.columnLabel.map((label: unknown) => typeof label === "string" ? label : "");
    if (!labels.some(Boolean)) return [];
    return table.columnData.filter(Array.isArray).map((values: unknown[]) => Object.fromEntries(labels.map((label, index) => [label, values[index]])));
  };
  sections.forEach((section: any, sectionIndex: number) => {
    const sectionKey = typeof section?.sectionKey === "string" ? section.sectionKey : `section-${sectionIndex + 1}`;
    const elements = Array.isArray(section?.elements) ? section.elements : [];
    elements.forEach((element: any, elementIndex: number) => {
      // l2 is the AIS utility's summary table. It has stable, human-readable
      // labels, unlike l1's detail-grid configuration objects.
      for (const [table, level] of [[element?.l2, "l2"], [element, "summary"]] as const) {
        toRows(table).forEach((row: Record<string, unknown>, rowIndex: number) => {
          const amountEntry = Object.entries(row).find(([label, value]) => /^(amount|derived amount)$/i.test(label) && asNumber(value) !== undefined);
          if (!amountEntry) return;
          const taxEntry = Object.entries(row).find(([label, value]) => /tax.*(deduct|collect)|tds|tcs/i.test(label) && asNumber(value) !== undefined);
          const description = [row["Information Category"], row["Information Description"], row["Information Source"]].map(asString).filter(Boolean).join(" · ");
          const path = `AIS.partB.sections[${sectionIndex}].elements[${elementIndex}].${level}.columnData[${rowIndex}]`;
          const category: AisFact["category"] = /tds|tcs|paymentoftaxes|demandandrefund/i.test(sectionKey) ? "tax" : "transaction";
          const fact: AisFact = { recordId: `ais-${sectionKey}-${elementIndex + 1}-${level}-${rowIndex + 1}`, section: sectionKey, category, sourcePath: path, amount: { value: asNumber(amountEntry[1])!, sourcePath: `${path}.${amountEntry[0]}` } };
          if (description) fact.description = { value: description, sourcePath: path };
          if (taxEntry) fact.taxDeducted = { value: asNumber(taxEntry[1])!, sourcePath: `${path}.${taxEntry[0]}` };
          facts.push(fact);
        });
      }
    });
  });
  return facts;
}

/** Parse decrypted/plaintext AIS JSON. Personal identifiers are deliberately not copied. */
export function parseAisJson(input: string | Json, sourcePath?: string): AisJsonRecord {
  let root: Json; let raw: string;
  if (typeof input === "string") {
    raw = input;
    try { root = JSON.parse(input); } catch { throw new Error("Unsupported AIS JSON: supplied AIS payload is encrypted or is not JSON"); }
  } else { root = input; raw = canonicalJson(input); }
  if (!isObj(root) && !Array.isArray(root)) throw new Error("Unsupported AIS JSON: expected an object or array");
  const facts: AisFact[] = []; const provenance: Record<string, string> = {};
  for (const fact of isObj(root) ? utilityTableFacts(root) : []) {
    facts.push(fact);
    provenance[`${fact.recordId}:${facts.length - 1}`] = fact.sourcePath;
  }
  let sequence = 0;
  const visit = (value: any, path: string, section: string) => {
    if (Array.isArray(value)) { value.forEach((x, i) => visit(x, `${path}[${i}]`, section)); return; }
    if (!isObj(value)) return;
    const values = Object.entries(value);
    const hasAmount = values.some(([k, v]) => /amount|value|income|gross|sale|purchase|taxdeduct|tds|tcs|credit/i.test(k) && asNumber(v) !== undefined);
    if (hasAmount) {
      const amountEntry = values.find(([k, v]) => /amount|income|grossamount|saleconsideration|purchasevalue|value/i.test(k) && asNumber(v) !== undefined);
      const tdsEntry = values.find(([k, v]) => /tds|deducted|withheld/i.test(k) && asNumber(v) !== undefined);
      const tcsEntry = values.find(([k, v]) => /tcs|collected/i.test(k) && asNumber(v) !== undefined);
      const date = findField(value, /date|period|year/i); const desc = findField(value, /description|nature|particular|name|source/i);
      const id = asString(value.recordId ?? value.RecordId ?? value.id ?? value.ID) ?? `record-${++sequence}`;
      const category: AisFact["category"] = /tds|tcs|tax|gst|advance/i.test(`${path} ${desc?.value ?? ""}`) ? "tax" : /transaction|sale|purchase|security|interest|dividend|salary|income|rent/i.test(`${path} ${desc?.value ?? ""}`) ? "transaction" : "income";
      const fact: AisFact = { recordId: id, section, category, sourcePath: path };
      if (desc && asString(desc.value)) fact.description = { value: asString(desc.value)!, sourcePath: `${path}.${desc.sourcePath}` };
      if (date && asString(date.value)) fact.date = { value: asString(date.value)!, sourcePath: `${path}.${date.sourcePath}` };
      if (amountEntry) fact.amount = { value: asNumber(amountEntry[1])!, sourcePath: `${path}.${amountEntry[0]}` };
      if (tdsEntry) fact.taxDeducted = { value: asNumber(tdsEntry[1])!, sourcePath: `${path}.${tdsEntry[0]}` };
      if (tcsEntry) fact.taxCollected = { value: asNumber(tcsEntry[1])!, sourcePath: `${path}.${tcsEntry[0]}` };
      facts.push(fact); provenance[`${id}:${facts.length - 1}`] = path;
    }
    for (const [key, child] of values) if (typeof child === "object" && child !== null) visit(child, `${path}.${key}`, sectionOf(path, key));
  };
  if (facts.length === 0) visit(root, "AIS", "AIS");
  const ayEntry = findField(root, /assessmentyear|assessment_year|ay/i); const ay = ayEntry && asString(ayEntry.value);
  const normalizedAy = ay && /^\d{4}$/.test(ay) ? `${ay}-${String((Number(ay) + 1) % 100).padStart(2, "0")}` : ay;
  const assessmentYear = normalizedAy ? { value: normalizedAy, sourcePath: `AIS.${ayEntry!.sourcePath}` } : undefined;
  const sourceFinancialYear = sourcePath?.match(/\b(20\d{2}-\d{2})\b/)?.[1];
  const financialYear = normalizedAy && /^\d{4}-\d{2}$/.test(normalizedAy)
    ? { value: `${Number(normalizedAy.slice(0, 4)) - 1}-${String(Number(normalizedAy.slice(0, 4)) % 100).padStart(2, "0")}`, sourcePath: assessmentYear!.sourcePath }
    : sourceFinancialYear ? { value: sourceFinancialYear, sourcePath: "source filename" } : undefined;
  const contentHash = createHash("sha256").update(raw).digest("hex");
  return { source: { type: "ais-json", ...(sourcePath ? { path: sourcePath } : {}), contentHash, parserVersion: AIS_JSON_PARSER_VERSION }, identity: { assessmentYear, financialYear, versionKey: `${normalizedAy ?? "unknown"}:${contentHash.slice(0, 16)}` }, facts, provenance, schemaNotes: ["AIS facts are retained independently for reconciliation; no ITR totals are changed.", "Only income, tax, and transaction-like numeric records are emitted; taxpayer identifiers are intentionally omitted."] };
}

export async function parseAisJsonFile(path: string): Promise<AisJsonRecord> { return parseAisJson(await readFile(path, "utf8"), path); }

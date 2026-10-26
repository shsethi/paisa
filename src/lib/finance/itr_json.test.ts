import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseItrJson } from "./itr_json";

const make = (assessmentYear: string, revised = false) => ({ ITR: { ITR2: {
  Form_ITR2: { FormName: "ITR-2", AssessmentYear: assessmentYear, SchemaVer: "test", FormVer: "test" },
  PartA_GEN1: { PersonalInfo: { Status: "filed" }, FilingStatus: { ReturnFileSec: revised ? 17 : 11, OptOutNewTaxRegime: "Y" } },
  "PartB-TI": { Salaries: 100, TotalIncome: 125, DeductionsUnderScheduleVIA: 10, CapGain: { ShortTerm: { TotalShortTerm: 25 } } },
  PartB_TTI: { TaxPaid: { TaxesPaid: { TotalTaxesPaid: 5, TDS: 5 } }, Refund: { RefundDue: 2 }, TaxPaidX: 9 },
  ScheduleVIA: { UsrDeductUndChapVIA: { Section80C: 10 } },
  ScheduleCGFor23: { TotScheduleCGFor23: 25 },
} } });

describe("ITR JSON importer", () => {
  test("extracts tax summary fields with source paths and stable content hash", () => {
    const first = parseItrJson(make("2024-25"));
    const second = parseItrJson(make("2024-25"));
    assert.equal(first.identity.assessmentYear?.value, "2024-25");
    assert.equal(first.identity.financialYear?.value, "2023-24");
    assert.equal(first.identity.regime.value, "old");
    assert.equal(first.incomeHeads.find(x => x.key === "salary")?.value, 100);
    assert.match(first.taxes.find(x => x.key === "refundDue")?.sourcePath ?? "", /RefundDue/);
    assert.match(first.provenance.totalIncome, /TotalIncome/);
    assert.equal(first.source.contentHash, second.source.contentHash);
    assert.equal(first.identity.versionKey, second.identity.versionKey);
  });

  test("keeps revised and current content distinct without inventing absent fields", () => {
    const current = parseItrJson(make("2024-25"), "A.Y. 2024-25.json");
    const revised = parseItrJson(make("2024-25", true), "A.Y. 2024-25 revised.json");
    assert.notEqual(current.identity.versionKey, revised.identity.versionKey);
    assert.equal(revised.identity.filingVersion, "revised");
    assert.equal(current.incomeHeads.find(x => x.key === "otherSources"), undefined);
  });

  test("rejects unsupported envelopes", () => {
    assert.throws(() => parseItrJson({ foo: 1 }), /missing ITR envelope/);
  });
});

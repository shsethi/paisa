import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseItrXml } from "./itr_xml";

const xml = (returnFileSec = "11") => `<?xml version="1.0"?><ns3:ITR xmlns:ns2="urn:itr1" xmlns:ns3="urn:main" xmlns="urn:master"><ns2:ITR1><Form_ITR1><FormName>ITR-1</FormName><AssessmentYear>2020</AssessmentYear><SchemaVer>Ver1.0</SchemaVer><FormVer>Ver1.0</FormVer></Form_ITR1><FilingStatus><ReturnFileSec>${returnFileSec}</ReturnFileSec><OptOutNewTaxRegime>Y</OptOutNewTaxRegime></FilingStatus><PersonalInfo><Status>I</Status></PersonalInfo><ITR1_IncomeDeductions><Salary>100</Salary><GrossTotIncome>120</GrossTotIncome><TotalIncome>110</TotalIncome><UsrDeductUndChapVIA><TotalChapVIADeductions>10</TotalChapVIADeductions></UsrDeductUndChapVIA></ITR1_IncomeDeductions><ITR1_TaxComputation><GrossTaxLiability>20</GrossTaxLiability></ITR1_TaxComputation><TaxPaid><TaxesPaid><TotalTaxesPaid>20</TotalTaxesPaid></TaxesPaid></TaxPaid></ns2:ITR1></ns3:ITR>`;

describe("ITR XML importer", () => {
  test("normalizes namespaced ITR1 paths and extracts summary fields", () => {
    const record = parseItrXml(xml(), "return.xml");
    assert.equal(record.identity.assessmentYear?.value, "2020-21");
    assert.equal(record.identity.financialYear?.value, "2019-20");
    assert.equal(record.identity.formName?.value, "ITR-1");
    assert.equal(record.identity.regime.value, "old");
    assert.equal(record.incomeHeads.find(x => x.key === "salary")?.value, 100);
    assert.equal(record.taxes.find(x => x.key === "grossTaxLiability")?.value, 20);
    assert.match(record.provenance.salary, /^ITR\.ITR1\./);
    assert.equal(record.source.contentHash, parseItrXml(xml(), "return.xml").source.contentHash);
  });

  test("keeps revised XML distinct", () => {
    const current = parseItrXml(xml(), "A.Y. 2020-21.xml");
    const revised = parseItrXml(xml("17"), "A.Y. 2020-21 revised.xml");
    assert.equal(current.identity.filingVersion, "original");
    assert.equal(revised.identity.filingVersion, "revised");
    assert.notEqual(current.identity.versionKey, revised.identity.versionKey);
  });

  test("rejects XML without a supported form", () => {
    assert.throws(() => parseItrXml("<ITR><Other /></ITR>"), /missing supported ITR form/);
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { decryptAisUtilityJson, parseAisJson } from "./ais_json";

describe("AIS JSON importer", () => {
  test("extracts independent facts with record and source provenance", () => {
    const doc = parseAisJson({ AssessmentYear: "2026", TaxpayerName: "do-not-copy", TDS: [{ RecordId: "tds-1", Nature: "Salary", Amount: "12,500", TDSAmount: 1250, TransactionDate: "2025-06-01" }] }, "ais.json");
    assert.equal(doc.identity.financialYear?.value, "2025-26");
    assert.equal(doc.facts.length, 1);
    assert.equal(doc.facts[0].recordId, "tds-1");
    assert.equal(doc.facts[0].amount?.value, 12500);
    assert.equal(doc.facts[0].taxDeducted?.value, 1250);
    assert.equal(JSON.stringify(doc).includes("do-not-copy"), false);
    assert.match(doc.facts[0].sourcePath, /AIS\.TDS\[0\]/);
    assert.equal(doc.source.path, "ais.json");
  });

  test("rejects the supplied encrypted payload with a safe error", () => {
    assert.throws(() => parseAisJson("ciphertext-not-json"), /encrypted or is not JSON/);
  });

  test("decrypts the AIS utility envelope locally", () => {
    const password = "abcde1234f01011990";
    const iv = randomBytes(16); const salt = randomBytes(16);
    const key = pbkdf2Sync("abcde1234fGQ39%*g01011990", salt, 1000, 32, "sha256");
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    const plain = JSON.stringify({ AssessmentYear: "2026", TDS: [] });
    const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
    const envelope = `${iv.toString("hex")}${salt.toString("hex")}${encrypted}`;
    assert.equal(decryptAisUtilityJson(envelope, password), plain);
    assert.throws(() => decryptAisUtilityJson(envelope, "wrong-password"), /could not be decrypted/);
  });

  test("normalizes AIS utility summary tables", () => {
    const doc = parseAisJson({ partB: { sections: [{ sectionKey: "tdsTcs", elements: [{ l2: { columnLabel: ["Information Category", "Amount"], columnData: [["Salary TDS", "12,500"]] } }] }] } });
    assert.equal(doc.facts.length, 1);
    assert.equal(doc.facts[0].category, "tax");
    assert.equal(doc.facts[0].amount?.value, 12500);
  });
});

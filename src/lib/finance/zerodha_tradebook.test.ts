import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { parseZerodhaTradebookCSV } from "./zerodha_tradebook";
import { importZerodhaTradebookFile } from "./zerodha_tradebook_import";
import { normalizeZerodhaTradebookRows } from "./zerodha_tradebook_normalize";

const header = "symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time";
const row = "ABC,INE000000000,2026-04-01,NSE,EQ,EQ,BUY,No,2,100.50,123,456,2026-04-01T10:00:00";
const roots: string[] = [];
function root() { const value = mkdtempSync(path.join(os.tmpdir(), "paisa-zerodha-")); roots.push(value); mkdirSync(path.join(value, "imports", "investments", "zerodha"), { recursive: true }); return value; }
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe("Zerodha tradebook parser and normalization", () => {
  test("parses buys, sells, and blank rows", () => {
    const parsed = parseZerodhaTradebookCSV(`${header}\n${row}\nABC,INE000000000,2026-04-02,NSE,EQ,EQ,SELL,No,1,101.00,124,457,2026-04-02T10:00:00\n\n`);
    assert.equal(parsed.readRows, 2); assert.equal(parsed.skippedBlankRows, 2); assert.equal(parsed.rows[0].sourceRow, 2);
    const normalized = normalizeZerodhaTradebookRows(parsed.rows, { contentSha256: "a".repeat(64), importId: "b".repeat(64), originalPath: "investments/zerodha/test.csv" });
    assert.equal(normalized.accepted.length, 2); assert.deepEqual(normalized.accepted.map((trade) => trade.side), ["buy", "sell"]); assert.equal(normalized.accepted[0].quantity, "2");
  });
  test("reports malformed rows with a source row locator", () => {
    const parsed = parseZerodhaTradebookCSV(`${header}\n${row}\nABC,INE000000000,not-a-date,NSE`);
    const normalized = normalizeZerodhaTradebookRows(parsed.rows, { contentSha256: "a".repeat(64), importId: "b".repeat(64), originalPath: "investments/zerodha/test.csv" });
    assert.equal(normalized.accepted.length, 1); assert.equal(normalized.errors[0].record_locator, "tradebook!row:3"); assert.equal(normalized.errors[0].code, "malformed_row");
  });
  test("rejects unsupported headers", () => { assert.throws(() => parseZerodhaTradebookCSV("symbol,date\nABC,2026-01-01\n"), /unsupported headers/); });
});

describe("Zerodha tradebook import storage", () => {
  test("writes an idempotent manifest and preserves changed history", () => {
    const financeRoot = root(); const source = path.join(financeRoot, "imports", "investments", "zerodha", "fixture.csv"); writeFileSync(source, `${header}\n${row}\n`);
    const first = importZerodhaTradebookFile({ root: financeRoot, file: "investments/zerodha/fixture.csv", now: new Date("2026-10-24T12:00:00Z") });
    assert.equal(first.status, "succeeded"); assert.deepEqual(first.row_counts, { read: 1, accepted: 1, rejected: 0, skipped: 1 }); assert.equal(first.already_imported, false);
    const directory = path.join(financeRoot, "extracted", "imports", "zerodha_tradebook"); assert.equal(readdirSync(directory).length, 1); const output = path.join(directory, readdirSync(directory)[0]); const manifest = JSON.parse(readFileSync(path.join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.content_sha256, createHash("sha256").update(readFileSync(source)).digest("hex")); assert.equal(statSync(path.join(output, "manifest.json")).mode & 0o777, 0o600);
    const repeat = importZerodhaTradebookFile({ root: financeRoot, file: "investments/zerodha/fixture.csv" }); assert.equal(repeat.already_imported, true);
    writeFileSync(source, `${header}\n${row}\n${row.replace("BUY", "SELL")}\n`); const changed = importZerodhaTradebookFile({ root: financeRoot, file: "investments/zerodha/fixture.csv" }); assert.equal(changed.already_imported, false); assert.equal(readdirSync(directory).length, 2);
  });
});

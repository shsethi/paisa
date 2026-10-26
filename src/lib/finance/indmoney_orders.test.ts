import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { parseIndmoneyOrders } from "./indmoney_orders";
import { importIndmoneyOrdersFile } from "./indmoney_orders_import";
import { normalizeIndmoneyOrderRows } from "./indmoney_orders_normalize";

const roots: string[] = [];
function root() { const value = mkdtempSync(path.join(os.tmpdir(), "paisa-indmoney-orders-")); roots.push(value); mkdirSync(path.join(value, "imports", "investments", "indmoney"), { recursive: true }); return value; }
function workbook(rows: unknown[][]) { const book = XLSX.utils.book_new(); const sheet = XLSX.utils.aoa_to_sheet([["INDmoney order history"], [], ...rows]); XLSX.utils.book_append_sheet(book, sheet, "Orders"); return XLSX.write(book, { type: "buffer", bookType: "xls" }) as Buffer; }
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe("INDmoney order XLS", () => {
  test("parses normalized orders and retains original values", () => {
    const parsed = parseIndmoneyOrders(workbook([["Order Date", "Stock Name", "Order Type", "Quantity", "Price", "Amount", "Currency", "Fees"], ["24/10/2026", "ACME", "BUY", 2, 10.5, 21, "USD", 0.25], ["25/10/2026", "ACME", "SELL", 1, 11, 11, "XYZ", 0]]));
    assert.equal(parsed.readRows, 2); assert.equal(parsed.rows[0].sourceRow, 4);
    const normalized = normalizeIndmoneyOrderRows(parsed.rows, { contentSha256: "a".repeat(64), importId: "b".repeat(64), originalPath: "investments/indmoney/test.xls" });
    assert.equal(normalized.accepted.length, 2); assert.deepEqual(normalized.accepted.map((r) => r.action), ["buy", "sell"]); assert.equal(normalized.accepted[0].date, "2026-10-24"); assert.equal(normalized.accepted[0].original_values["Stock Name"], "ACME"); assert.deepEqual(normalized.accepted[1].flags, ["unsupported_currency"]);
  });
  test("rejects malformed rows with row locators", () => {
    const parsed = parseIndmoneyOrders(workbook([["Order Date", "Symbol", "Action", "Quantity", "Price"], ["not a date", "ACME", "BUY", 1, 2]]));
    const normalized = normalizeIndmoneyOrderRows(parsed.rows, { contentSha256: "a".repeat(64), importId: "b".repeat(64), originalPath: "investments/indmoney/test.xls" });
    assert.equal(normalized.accepted.length, 0); assert.equal(normalized.errors[0].record_locator, "Orders!row:4"); assert.equal(normalized.errors[0].code, "invalid_date");
  });
  test("writes idempotent manifest and keeps changed source versions", () => {
    const financeRoot = root(); const source = path.join(financeRoot, "imports", "investments", "indmoney", "fixture.xls"); const bytes = workbook([["Order Date", "Symbol", "Action", "Quantity", "Price"], ["2026-10-24", "ACME", "BUY", 1, 2]]); writeFileSync(source, bytes);
    const first = importIndmoneyOrdersFile({ root: financeRoot, file: "investments/indmoney/fixture.xls", now: new Date("2026-10-24T12:00:00Z") }); assert.equal(first.status, "succeeded"); assert.equal(first.already_imported, false);
    const directory = path.join(financeRoot, "extracted", "imports", "indmoney_orders"); const output = path.join(directory, readdirSync(directory)[0]); const manifest = JSON.parse(readFileSync(path.join(output, "manifest.json"), "utf8")); assert.equal(manifest.content_sha256, createHash("sha256").update(bytes).digest("hex")); assert.equal(statSync(path.join(output, "manifest.json")).mode & 0o777, 0o600);
    assert.equal(importIndmoneyOrdersFile({ root: financeRoot, file: "investments/indmoney/fixture.xls" }).already_imported, true); writeFileSync(source, Buffer.concat([bytes, Buffer.from("\n") ])); importIndmoneyOrdersFile({ root: financeRoot, file: "investments/indmoney/fixture.xls" }); assert.equal(readdirSync(directory).length, 2);
  });
});

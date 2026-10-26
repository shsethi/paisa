import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseIndmoneyHoldings } from "./indmoney_holdings";

const source = path.resolve("../My Finance/imports/investments/indmoney/IND-HOLDINGS_REPORTXX1670710-2026-10-24-V04.xls");

test("parses the observed INDmoney holdings export with row provenance", () => {
  const parsed = parseIndmoneyHoldings(readFileSync(source));
  assert.ok(parsed.rows.length > 0);
  assert.equal(parsed.rows.every((row) => row.currency === "USD" && /^HOLDINGS_BOOK!row:\d+$/.test(row.record_locator)), true);
});

test("rejects a non-workbook input", () => {
  assert.throws(() => parseIndmoneyHoldings(Buffer.from("not a workbook")), /INDmoney holdings workbook/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseNsdlCasPDF } from "./nsdl_cas_pdf";

test("parses the supplied NSDL CAS when the local password is provided", { skip: !process.env.NSDL_CAS_PDF_PASSWORD }, async () => {
  const source = path.resolve("../My Finance/imports/investments/cas/NSDLe-CAS_111942094_SEP_2026.PDF");
  const holdings = await parseNsdlCasPDF(readFileSync(source), process.env.NSDL_CAS_PDF_PASSWORD!);
  assert.ok(holdings.length > 0);
  assert.ok(holdings.some((holding) => holding.security.category === "mutual_fund_folio"));
  assert.ok(holdings.some((holding) => holding.security.category !== "mutual_fund_folio"));
  assert.equal(holdings.every((holding) => /^\d{4}-\d{2}-\d{2}$/.test(holding.as_of_date) && Number(holding.current_value) >= 0), true);
});


import { createHash } from "node:crypto";
import type { BankTransaction, ClassificationDetail } from "./icici_normalize";
import type { FederalBankRawRow } from "./federal_bank_pdf";

export type FederalBankNormalizationError = {
  code: string;
  message: string;
  record_locator: string;
};

export type FederalBankNormalizationResult = {
  accepted: BankTransaction[];
  errors: FederalBankNormalizationError[];
};

type SourceContext = {
  contentSha256: string;
  importId: string;
  originalPath: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isoDate(value: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    return null;
  return `${yearText}-${monthText}-${dayText}`;
}

function decimal(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replaceAll(",", "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  return normalized.replace(/^0+(?=\d)/, "");
}

function isZero(value: string): boolean {
  return !/[1-9]/.test(value);
}

function classify(description: string): Pick<BankTransaction, "category" | "classification"> & {
  detail: ClassificationDetail;
} {
  if (/\bSBINT\s*:/i.test(description)) {
    return {
      category: "interest",
      classification: "income",
      detail: {
        rule: "explicit_interest_marker",
        reason: "Statement description explicitly identifies savings account interest.",
        confidence: "high",
        review_needed: false
      }
    };
  }
  return {
    category: null,
    classification: null,
    detail: {
      rule: "uncategorized",
      reason: "No supported transaction classification matched the statement description.",
      confidence: "low",
      review_needed: true
    }
  };
}

export function normalizeFederalBankRows(
  rows: FederalBankRawRow[],
  source: SourceContext
): FederalBankNormalizationResult {
  const accepted: BankTransaction[] = [];
  const errors: FederalBankNormalizationError[] = [];

  for (const row of rows) {
    const locator = `page:${row.page}:transaction:${row.sourceRow}`;
    const reject = (code: string, message: string) =>
      errors.push({ code, message, record_locator: locator });
    const date = isoDate(row.transactionDate);
    if (!date) {
      reject("invalid_transaction_date", "Transaction date is missing or invalid.");
      continue;
    }
    if (!row.description.trim()) {
      reject("missing_description", "Transaction description is missing or invalid.");
      continue;
    }
    const withdrawal = decimal(row.withdrawalAmount);
    const deposit = decimal(row.depositAmount);
    const balance = row.balance === null ? null : decimal(row.balance);
    if (withdrawal === null || deposit === null) {
      reject("invalid_amount", "Withdrawal or deposit amount is missing or invalid.");
      continue;
    }
    if (row.balance !== null && balance === null) {
      reject("invalid_balance", "Balance is invalid.");
      continue;
    }
    const withdrawalIsZero = isZero(withdrawal);
    const depositIsZero = isZero(deposit);
    if (withdrawalIsZero === depositIsZero) {
      reject("ambiguous_amount", "Exactly one of withdrawal or deposit must be nonzero.");
      continue;
    }

    const classification = classify(row.description);
    accepted.push({
      record_type: "bank_transaction",
      source_id: sha256(`federal_bank_statement\n${source.contentSha256}\n${locator}`),
      date,
      description: row.description,
      debit: withdrawalIsZero ? null : withdrawal,
      credit: depositIsZero ? null : deposit,
      currency: "INR",
      balance,
      category: classification.category,
      classification: classification.classification,
      classification_detail: classification.detail,
      source: {
        import_id: source.importId,
        original_path: source.originalPath,
        content_sha256: source.contentSha256,
        record_locator: locator
      },
      review_status: "needs_review"
    });
  }
  return { accepted, errors };
}

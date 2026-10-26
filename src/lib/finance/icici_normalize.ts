import { createHash } from "node:crypto";
import type { ICICIRawRow } from "./icici_xls";

export type ClassificationDetail = {
  rule: string;
  reason: string;
  confidence: "high" | "medium" | "low";
  review_needed: boolean;
};

export type BankTransaction = {
  record_type: "bank_transaction";
  source_id: string;
  date: string;
  description: string;
  debit: string | null;
  credit: string | null;
  currency: "INR";
  balance: string | null;
  category: string | null;
  classification: string | null;
  classification_detail: ClassificationDetail;
  source: {
    import_id: string;
    original_path: string;
    content_sha256: string;
    record_locator: string;
  };
  review_status: "needs_review";
};

export type NormalizationError = {
  code: string;
  message: string;
  record_locator: string;
};

export type NormalizationResult = {
  accepted: BankTransaction[];
  errors: NormalizationError[];
};

type SourceContext = {
  contentSha256: string;
  importId: string;
  originalPath: string;
};

const sourceType = "icici_bank_statement";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function dateISO(value: unknown): string | null {
  if (typeof value !== "string") return null;
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
  ) {
    return null;
  }
  return `${yearText}-${monthText}-${dayText}`;
}

function decimalText(value: unknown, allowNegative = false): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match || (match[1] && !allowNegative)) return null;
  const integer = match[2].replace(/^0+(?=\d)/, "");
  const fraction = match[3];
  const isZero = /^0+$/.test(integer) && (!fraction || /^0+$/.test(fraction));
  const sign = match[1] && !isZero ? "-" : "";
  return `${sign}${integer}${fraction === undefined ? "" : `.${fraction}`}`;
}

type Classification = Pick<BankTransaction, "category" | "classification"> & {
  detail: ClassificationDetail;
};

const rules: Array<{
  id: string;
  pattern: RegExp;
  category: string;
  classification: string;
  reason: string;
  confidence: "high" | "medium";
}> = [
  {
    id: "tax_payment",
    pattern: /\b(?:income tax|tax payment|tax challan|tds|gst payment)\b/i,
    category: "tax",
    classification: "tax",
    reason: "Description contains a recognized tax payment term.",
    confidence: "high",
  },
  {
    id: "loan_repayment",
    pattern: /\b(?:emi|loan repayment|loan installment|loan instalment)\b/i,
    category: "loan_emi",
    classification: "debt_repayment",
    reason: "Description contains a recognized loan repayment term.",
    confidence: "high",
  },
  {
    id: "card_payment",
    pattern: /\b(?:credit card payment|credit card bill|card bill payment)\b/i,
    category: "card_payment",
    classification: "transfer",
    reason: "Description identifies a credit card bill payment.",
    confidence: "high",
  },
  {
    id: "investment",
    pattern: /\b(?:zerodha|kuvera|mutual fund|sip|investment|nps contribution)\b/i,
    category: "investment",
    classification: "investment",
    reason: "Description contains a recognized investment term or provider.",
    confidence: "high",
  },
  {
    id: "salary",
    pattern: /\b(?:salary|payroll)\b/i,
    category: "salary",
    classification: "income",
    reason: "Description identifies salary or payroll.",
    confidence: "high",
  },
  {
    id: "own_account_transfer",
    pattern: /\b(?:self transfer|own account|transfer to own|between own accounts)\b/i,
    category: "transfer",
    classification: "transfer",
    reason: "Description explicitly identifies a transfer between own accounts.",
    confidence: "medium",
  },
  {
    id: "recurring_payment_instruction",
    pattern: /\b(?:nach|ecs|standing instruction|auto.?debit)\b/i,
    category: "recurring_expense",
    classification: "spending",
    reason: "Description identifies an automatic payment instruction; recurrence needs review.",
    confidence: "medium",
  },
];

export function classifyICICI(description: string): Classification {
  for (const rule of rules) {
    if (rule.pattern.test(description)) {
      return {
        category: rule.category,
        classification: rule.classification,
        detail: {
          rule: rule.id,
          reason: rule.reason,
          confidence: rule.confidence,
          review_needed: rule.confidence !== "high",
        },
      };
    }
  }
  return {
    category: null,
    classification: null,
    detail: {
      rule: "uncategorized",
      reason: "No supported classification rule matched.",
      confidence: "low",
      review_needed: true,
    },
  };
}

export function normalizeICICIRows(
  rows: ICICIRawRow[],
  source: SourceContext,
): NormalizationResult {
  const accepted: BankTransaction[] = [];
  const errors: NormalizationError[] = [];

  for (const row of rows) {
    const recordLocator = `OpTransactionHistory!row:${row.sourceRow}`;
    const reject = (code: string, message: string) =>
      errors.push({ code, message, record_locator: recordLocator });

    const date = dateISO(row.transactionDate);
    if (!date) {
      reject("invalid_transaction_date", "Transaction date is missing or invalid.");
      continue;
    }
    if (
      typeof row.transactionRemarks !== "string" ||
      row.transactionRemarks.trim() === ""
    ) {
      reject("missing_description", "Transaction description is missing or invalid.");
      continue;
    }

    const withdrawal = decimalText(row.withdrawalAmount);
    const deposit = decimalText(row.depositAmount);
    const balance =
      row.balance === null ? null : decimalText(row.balance, true);
    if (withdrawal === null || deposit === null) {
      reject("invalid_amount", "Withdrawal or deposit amount is missing or invalid.");
      continue;
    }
    if (row.balance !== null && balance === null) {
      reject("invalid_balance", "Balance is invalid.");
      continue;
    }

    const withdrawalIsZero = !/[1-9]/.test(withdrawal);
    const depositIsZero = !/[1-9]/.test(deposit);
    if (withdrawalIsZero === depositIsZero) {
      reject("ambiguous_amount", "Exactly one of withdrawal or deposit must be nonzero.");
      continue;
    }

    const classification = classifyICICI(row.transactionRemarks);
    const sourceId = sha256(`${sourceType}\n${source.contentSha256}\n${recordLocator}`);
    accepted.push({
      record_type: "bank_transaction",
      source_id: sourceId,
      date,
      description: row.transactionRemarks,
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
        record_locator: recordLocator,
      },
      review_status: "needs_review",
    });
  }
  return { accepted, errors };
}

export function isValidSHA256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export function createICICIImportId(originalPath: string, contentSha256: string): string {
  return sha256(`${sourceType}\n${originalPath}\n${contentSha256}`);
}

# Form 16 local extraction feasibility

## Decision

The supplied Form 16 is now supported by a local, source-specific summary parser. It extracts only labeled Part B summary fields and refuses output unless the taxable-income and tax-payable formulas reconcile. It does not import challan rows, perquisite details, or arbitrary Form 16 layouts.

## Evidence

- Local `pdfjs-dist` extraction read all 9 pages and returned about 19.8k characters.
- All 9 pages contained tax-field labels and year references.
- Extracted labels include assessment year, financial year, gross salary, salary received from other employers, deductions, taxable income, rebate, net tax payable, tax deducted/deposited, and perquisite summaries.
- The current runtime emitted standard-font warnings during extraction; text was still returned. No OCR or remote service was used.

## Candidate field map

| Summary field | Source label family | Treatment |
| --- | --- | --- |
| Assessment / financial year | Assessment Year; Financial Year | Capture as source metadata; validate year relationship. |
| Salary components | Gross Salary; salary from current/other employers; perquisites | Retain component labels and source page/line. Do not sum overlapping subtotals. |
| Deductions and exemptions | Deductions under section; exemptions/allowances | Store individually when the table structure is unambiguous. |
| Taxable income | Total taxable income | Preserve the stated total as a distinct source fact. |
| Tax calculation | Rebate, surcharge, net tax payable | Preserve each labeled amount; do not recompute tax. |
| Withholding | Tax deducted and deposited; challan-wise details | Preserve challan rows separately and reconcile only through an explicit future task. |

## Limitation

Support is intentionally restricted to the observed layout. The parser preserves page/Y-coordinate provenance, performs arithmetic checks, and fails on missing required labels. The original PDF remains the auditable source.

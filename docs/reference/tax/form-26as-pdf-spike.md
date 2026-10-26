# Form 26AS PDF extraction spike

This note records a local-only spike against the historical Form 26AS PDFs available
under the developer's local finance imports. No PDF contents, taxpayer identifiers,
names, addresses, or transaction values are copied into the repository.

## Corpus and method

- 17 PDFs, one each for 2009 through 2025.
- PDF.js `3.10.111` (the version already used by Paisa) opened every file without a
  password or OCR step.
- The check recorded page count, number of non-empty text items, character counts,
  and the presence of section/header-like tokens. It did not persist extracted text.

All samples are text PDFs rather than image-only scans, so PDF.js is a viable first
stage. That is not sufficient to treat the text stream as a table, however.

## Observed layout drift

| Sample years | Pages | Non-empty PDF.js text items | Observation |
| --- | ---: | ---: | --- |
| 2009–2015 | 4 | 2,134 | Stable-looking shell, but date/number values are split across positioned fragments. |
| 2016 | 4 | 2,231 | Additional numeric content; still no stable row-delimited stream. |
| 2017–2021 | 4 | 2,682–2,770 | More populated sections and changing fragment counts. |
| 2022 | 5 | 3,144 | Page break/layout change. |
| 2023–2025 | 4 | 2,550–2,799 | Later section headings are detectable, but column/row fragment boundaries still vary. |

The same extraction mode produces zero matches for a space-joined date pattern in
several samples even though date-shaped sequences exist when fragments are concatenated
without spaces. This demonstrates why a plain `textContent.items.map(...).join(" ")`
parser is unsafe. The reading order is visual-position dependent, and values can be
split or interleaved with neighbouring columns.

The existing caret-delimited fixture (`fixture/import/Annual Income Tax Statement
26AS/yearly.txt`) is substantially easier to import: it has explicit fields and
record boundaries, and its template intentionally uses the TDS transaction date and
tax-deducted columns. The PDF samples do not expose that contract directly.

## Implemented coverage decision

The local importer now reads only deductor-level summary rows, identified by their
TAN and three reported totals. It groups text by page/Y coordinate, records page and
row provenance, and does not attempt fragile transaction-row reconstruction. All 17
available PDFs opened successfully; 32 deductor summaries were imported, while the
seven early statements with no reported deductors produced valid empty summaries.

Detailed transaction rows remain unsupported. Extending coverage requires:

1. Group text items by page and approximate Y coordinate, then sort each visual line
   by X coordinate (with a tested tolerance).
2. Identify section and column headers as anchors; parse only known row schemas rather
   than relying on global token positions.
3. Validate dates, numeric fields, and per-deductor totals before producing ledger
   postings. Refuse ambiguous rows instead of guessing.
4. Keep layout profiles for at least the pre-2016, 2016–2021, 2022, and 2023+
   families, and retain sanitized fixtures for each profile.
5. Continue accepting the current caret-delimited/TXT export as the stable detailed import
   path. PDF support can be added incrementally once representative sanitized fixtures
   and expected ledger rows exist.

The available private PDFs are used only for local integration checks; no private
values are copied into repository fixtures or documentation.

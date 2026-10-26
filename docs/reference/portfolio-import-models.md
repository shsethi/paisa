# Portfolio import record review

The investment importers preserve each provider's source shape and provenance. The common view should adapt these records at read time rather than rewriting imported artifacts.

## Shared view fields

| View | Common fields | Source-specific fields and limits |
| --- | --- | --- |
| Holding | `source_id`, security label/identifier, units, currency, current value, as-of date, source path and row | Kuvera has INR cost basis, NAV and returns, but its export omits an as-of date. INDmoney has USD average price and value, plus an as-of date, but no directly supplied cost-basis total. Do not convert currencies or infer missing dates/cost basis. |
| Trade | `source_id`, date, instrument, buy/sell, quantity, price, currency, source path and row | Zerodha provides ISIN, exchange, segment, series and order/trade identifiers. INDmoney orders retain original cell values and may have an `other` action or unsupported currency flag. Charges are available only where supplied. |
| Realized gain | `source_id` when row-level importer identity exists, financial year, security/asset label if present, gain type, amount, currency, source sheet/row | Zerodha includes security-level and asset-summary workbook rows. Kuvera currently imports statement-level STCG/LTCG only. INDmoney tax summaries include several tax categories and an explicit `possible_overlap` marker; they are not trade lots. |

## NSDL CAS holdings

The password-protected NSDL consolidated account statement is imported locally from
the observed September 2026 layout. Demat holdings and mutual-fund folios retain the
statement date, identifier, units, available cost/NAV/value fields, and page/Y source
locator. Broker and fund-platform overlap is expected, so CAS records carry stable
identifier-based overlap keys and remain reviewable instead of being silently added
to net-worth totals.

## Identity and provenance

Each row remains linked to its original import using `source.import_id`, `source.original_path`, `source.content_sha256`, and a stable row locator. Summary rows are never converted into trades, and holdings snapshots are not treated as transaction history. Cross-source matches remain separate until a reviewed reconciliation rule exists.

## Unknown data and overlap

Unavailable values remain null or are omitted according to the source model. In particular, undated Kuvera holdings are not included in as-of net worth totals, USD holdings remain separate from INR totals, and tax summaries marked as potentially overlapping are excluded from net-worth totals until reviewed.

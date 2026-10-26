# Net worth and allocation calculations

## Net worth

For each currency independently:

```text
net worth = included assets - included liabilities
```

Only records dated on or before the selected as-of date are eligible. Holdings require a valid as-of date and currency. For manually entered asset/liability snapshots, the calculation keeps the latest value on or before the selected date for each normalized balance type, category, label, owner, and account label. Cash-flow rows are not balances.

Rows sharing an explicit overlap key are treated as unresolved duplicates and excluded from totals until reviewed. Holdings default to a public security identifier when available; manual rows default to their normalized balance identity. Because a manual label and a broker security identifier may not be equivalent, callers should supply an explicit overlap key when they know two rows represent the same asset. Excluded records and their reasons remain visible in the service result. Currencies are not converted or combined.

Each included line retains its source import, original path, row locator, and optional source content hash.

## Allocation and target drift

Holdings map to an asset class by exact security match first, then exact holding-type match. Unmapped holdings remain in the total portfolio denominator and are reported separately.

```text
current allocation % = class value / total holding value × 100
target value = total holding value × target allocation %
drift = current allocation % - target allocation %
amount to target = target value - class value
```

Targets must be non-negative and sum to 100%. A positive amount to target indicates the value difference needed to reach the target; it is informational and does not imply a trade. Calculations do not convert currencies or estimate unavailable values.

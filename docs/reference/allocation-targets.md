---
description: "How to configure and track asset allocation of your mutual funds, stocks etc."
---

# Allocation Targets

Paisa allows you to set a allocation target for a group of accounts
which might represent your assets like mutual funds, stocks etc. The
allocation page shows how far your current allocation is from the
allocation target. For example, to keep a 40:60 split between debt and
equity, use the following configuration. The account name can have `*`
which matches any characters

```yaml
allocation_targets:
  - name: Debt
    target: 40
    accounts:
      - Assets:Debt:*
  - name: Equity
    target: 60
    accounts:
      - Assets:Equity:*
```

## Holdings page report

The imported-holdings page has a local-only editor for mapping imported source
categories (and, optionally, an exact security) to an asset class, plus target
percentages. The browser stores this configuration in `localStorage`; it is not
sent to the server and does not modify source files or imported records.

For each currency, the report uses these formulas:

```text
portfolio value  = sum of every holding with a usable current value
actual %         = asset-class current value / portfolio value × 100
target value     = portfolio value × target % / 100
drift            = actual % − target %  (percentage points)
amount to target = target value − current value
```

Positive amount-to-target means the target class would need more value; a
negative amount means it is above target. Values are informational only: the
page never places or recommends trades. Unmapped holdings remain in the
portfolio denominator, are shown as unclassified, and are excluded from
asset-class values. Targets must sum to 100%; invalid totals are displayed as
configuration warnings while the actual values remain visible. The same target
configuration is applied independently to each currency report, without FX
conversion.

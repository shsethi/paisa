# Paisa

[![Matrix](https://img.shields.io/matrix/paisa%3Amatrix.org?logo=matrix)](https://matrix.to/#/#paisa:matrix.org)

**Paisa** is a Personal finance manager. It builds on
top of the [ledger](https://www.ledger-cli.org/) double entry accounting tool. Checkout
[documentation](https://paisa.fyi) to get started.

# Demo

A demo of the Web UI can be found at [https://demo.paisa.fyi](https://demo.paisa.fyi)

## Import local portfolio snapshots into Ledger

The local finance importers for Kuvera, INDmoney, and manual asset/liability
balances keep their normalized records under the `My Finance` folder. To show
those snapshots in the built-in **Assets → Balance** view, generate a Ledger
include after refreshing the imports:

```sh
npm run finance:export-ledger -- \
  --root "/path/to/My Finance" \
  --as-of YYYY-MM-DD \
  --journal /path/to/main.ledger
```

The command creates (or replaces)
`My Finance/generated/paisa-imported-balances.ledger` and adds its `include`
directive to the journal once. Later runs replace the generated snapshot rather
than appending duplicate postings. Run Paisa Update/Sync afterwards to refresh
the built-in reports.

`--as-of` is required for holding exports that do not include a snapshot date,
such as Kuvera exports. Use `--dry-run` first to see the number of records that
would be included or skipped without writing anything.

The export creates opening-balance postings from point-in-time values; it does
not reconstruct purchase or sale history, cost lots, capital gains, or XIRR.
Use a real personal journal, not Paisa's demo journal, or the imported balances
will be combined with demo transactions.

## Status

I use it to track my personal finance. Most of my personal use cases
are covered. Feel free to open an issue if you found a bug or start a
discussion if you have a feature request. If you have any question,
you can ask on [Matrix chat](https://matrix.to/#/#paisa:matrix.org).

## License

This software is licensed under [the AGPL 3 or later license](./COPYING).

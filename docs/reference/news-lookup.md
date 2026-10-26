# Privacy-safe public news lookup

The local news service (`internal/service`) defines a provider boundary. A
caller must construct a `PublicNewsIdentifier` with
one of these public kinds:

- ticker
- company
- fund
- sector

Only the identifier kind and value are present in `Query`. Account names,
holding quantities/units, balances, invested amounts, and other private
portfolio fields are not accepted by validation and are not available to a
provider implementation. Values that resemble account paths, currency
amounts, or quantity expressions are rejected before a provider is called.

Providers are injected through `NewsProvider` and receive a fake-friendly,
small request. The optional `AlphaVantageNewsProvider` maps ticker identifiers
to Alpha Vantage `NEWS_SENTIMENT`'s `tickers` parameter and supported sector
identifiers to its `topics` parameter. It reads `ALPHAVANTAGE_API_KEY` only
when explicitly configured. Alpha Vantage documents `NEWS_SENTIMENT` as a
premium API function, so the feature remains disabled/unconfigured without a
key and no request is made.

See the [official Alpha Vantage API documentation](https://www.alphavantage.co/documentation/#news-sentiment)
for the current endpoint terms and supported topic slugs.

Successful responses are mapped into local `NewsItem` records containing only:

- headline
- source
- publication date
- link
- related public identifier/category
- a short relevance note

`NewsService` stores these records in a process-local `Store` and returns a
snapshot for display. Results last for the lifetime of the Paisa process; they
are not written to source files or retained after restart.

The application bootstrap registers the standalone HTTP handlers with:

```go
RegisterNewsRoutes(router, NewAlphaVantageNewsHTTPHandler())
```

The UI route is `/more/news`; it submits only `kind` and `value`.

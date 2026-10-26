# Public market price cache

Paisa sends only a compact public identifier (`symbol`, optional `exchange`,
and `asset_type`) to the configured provider. The refresh endpoint rejects
unknown request fields. Quote reads use the local cache and never call a
provider; network lookup happens only after the user presses **Refresh quote**
on a supported stock or ETF.

Quotes are stored under `My Finance/extracted/cache/public-market-prices.json`
with the public identifier, decimal value, currency, provider quote date,
local refresh time, provider name, and source URL. API keys are not written to
the cache. A failed lookup leaves the previous quote intact. Unsupported
instrument types remain unpriced, and no currency conversion is performed.

Configure `ALPHAVANTAGE_API_KEY` to enable Alpha Vantage. `ALPHAVANTAGE_CURRENCY`
sets the quote currency because `GLOBAL_QUOTE` does not return a currency field;
the default is USD and should only be used where that matches the instrument.
The quote endpoint describes its default quote as updated at the end of each
trading day; real-time or delayed US quotes require a premium plan. See the
[official GLOBAL_QUOTE documentation](https://www.alphavantage.co/documentation/)
and [Alpha Vantage terms](https://www.alphavantage.co/terms_of_service/) before
configuring a key. The service is intended here for local personal use.

HTTP endpoints:

- `GET /api/price/public` returns all cached public quotes.
- `GET /api/price/public?symbol=IBM&asset_type=stock` reads one local cached quote.
- `POST /api/price/public/refresh` accepts only a JSON object with `symbol`,
  optional `exchange`, and optional `asset_type`, and performs an explicit
  provider lookup.

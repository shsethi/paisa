package service

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/shopspring/decimal"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakePublicPriceProvider struct {
	name      string
	supported bool
	quote     PublicQuote
	err       error
	requests  []PublicIdentifier
}

func (p *fakePublicPriceProvider) Name() string { return p.name }

func (p *fakePublicPriceProvider) Supports(PublicIdentifier) bool { return p.supported }

func (p *fakePublicPriceProvider) Lookup(_ context.Context, id PublicIdentifier) (PublicQuote, error) {
	p.requests = append(p.requests, id)
	if p.err != nil {
		return PublicQuote{}, p.err
	}
	return p.quote, nil
}

func TestPriceCacheRefreshUsesPublicIdentifierAndPreservesValueOnFailure(t *testing.T) {
	identifier := PublicIdentifier{Symbol: " aapl ", Exchange: "nasdaq", AssetType: InstrumentStock}
	provider := &fakePublicPriceProvider{
		name:      "fake",
		supported: true,
		quote: PublicQuote{
			Value:     decimal.RequireFromString("192.35"),
			Currency:  "USD",
			AsOf:      time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC),
			Source:    "fake-feed",
			SourceURL: "https://example.test/quote/AAPL",
		},
	}
	cache := NewPriceCache()

	first, err := cache.Refresh(context.Background(), provider, identifier)
	require.NoError(t, err)
	assert.Equal(t, "AAPL", first.Identifier.Symbol)
	assert.Equal(t, "NASDAQ", first.Identifier.Exchange)
	assert.Equal(t, "USD", first.Currency)
	assert.Equal(t, "fake", first.Provider)
	assert.Equal(t, "fake-feed", first.Source)
	assert.False(t, first.RefreshedAt.IsZero())
	assert.Equal(t, []PublicIdentifier{{Symbol: "AAPL", Exchange: "NASDAQ", AssetType: InstrumentStock}}, provider.requests)

	// Get is local-only and does not invoke the provider.
	got, ok := cache.Get(identifier)
	require.True(t, ok)
	assert.Equal(t, first.Value, got.Value)
	assert.Len(t, provider.requests, 1)

	provider.err = errors.New("temporary provider outage")
	failed, err := cache.Refresh(context.Background(), provider, identifier)
	require.Error(t, err)
	assert.Equal(t, first.Value, failed.Value)
	assert.Equal(t, first.RefreshedAt, failed.RefreshedAt)
	stillCached, ok := cache.Get(identifier)
	require.True(t, ok)
	assert.Equal(t, first.Value, stillCached.Value)
	assert.Equal(t, first.RefreshedAt, stillCached.RefreshedAt)
}

func TestPriceCacheLeavesUnsupportedIdentifiersEmpty(t *testing.T) {
	provider := &fakePublicPriceProvider{name: "fake", supported: false}
	cache := NewPriceCache()
	value, err := cache.Refresh(context.Background(), provider, PublicIdentifier{Symbol: "BTCUSD", AssetType: "crypto"})
	require.ErrorIs(t, err, ErrUnsupportedIdentifier)
	assert.Empty(t, value)
	assert.Empty(t, provider.requests)
}

func TestMarketIdentifierRejectsPrivateTextBeforeProviderBoundary(t *testing.T) {
	for _, symbol := range []string{"portfolio 10000", "user@example.com", "ACCT:123", "AAPL 10 shares"} {
		_, err := (PublicIdentifier{Symbol: symbol, AssetType: InstrumentStock}).Normalize()
		if !errors.Is(err, ErrInvalidIdentifier) {
			t.Fatalf("expected private or malformed symbol %q to be rejected, got %v", symbol, err)
		}
	}
}

func TestPriceCachePersistsOnlyQuoteMetadataLocally(t *testing.T) {
	path := t.TempDir() + "/market-prices.json"
	cache, err := OpenPriceCache(path)
	require.NoError(t, err)
	provider := &fakePublicPriceProvider{
		name:      "fake",
		supported: true,
		quote: PublicQuote{
			Value:     decimal.RequireFromString("101.20"),
			Currency:  "INR",
			AsOf:      time.Date(2026, 10, 24, 0, 0, 0, 0, time.UTC),
			Source:    "fake",
			SourceURL: "https://example.test/quote/RELIANCE",
		},
	}
	_, err = cache.Refresh(context.Background(), provider, PublicIdentifier{Symbol: "RELIANCE", AssetType: InstrumentStock})
	require.NoError(t, err)

	reloaded, err := OpenPriceCache(path)
	require.NoError(t, err)
	value, ok := reloaded.Get(PublicIdentifier{Symbol: "reliance", AssetType: InstrumentStock})
	require.True(t, ok)
	assert.Equal(t, "101.2", value.Value.String())
	assert.Equal(t, "INR", value.Currency)
	assert.Equal(t, "fake", value.Provider)
	contents, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.NotContains(t, string(contents), "account")
	assert.NotContains(t, string(contents), "units")
}

type alphaRoundTripFunc func(*http.Request) (*http.Response, error)

func (f alphaRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestAlphaVantageProviderUsesPublicSymbolOnlyAndRedactsAPIKeyFromSource(t *testing.T) {
	var received *http.Request
	client := &http.Client{Transport: alphaRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		received = req
		body := `{"Global Quote":{"01. symbol":"IBM","05. price":"222.10","07. latest trading day":"2026-10-23"}}`
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}
	provider := NewAlphaVantageProvider("secret-key", "USD")
	provider.BaseURL = "https://prices.example.test/query"
	provider.Client = client

	quote, err := provider.Lookup(context.Background(), PublicIdentifier{Symbol: "ibm", AssetType: InstrumentStock})
	require.NoError(t, err)
	require.NotNil(t, received)
	query := received.URL.Query()
	assert.Equal(t, "GLOBAL_QUOTE", query.Get("function"))
	assert.Equal(t, "IBM", query.Get("symbol"))
	assert.Equal(t, "secret-key", query.Get("apikey"))
	assert.NotContains(t, received.URL.RawQuery, "account")
	assert.NotContains(t, received.URL.RawQuery, "units")
	assert.Equal(t, "222.1", quote.Value.String())
	assert.Equal(t, "USD", quote.Currency)
	assert.Equal(t, "https://prices.example.test/query?function=GLOBAL_QUOTE&symbol=IBM", quote.SourceURL)
	assert.NotContains(t, quote.SourceURL, "secret-key")
}

func TestAlphaVantageProviderReportsDocumentedAPIErrors(t *testing.T) {
	client := &http.Client{Transport: alphaRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		body := `{"Note":"Thank you for using Alpha Vantage! Please consider upgrading."}`
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}
	provider := NewAlphaVantageProvider("secret-key")
	provider.Client = client
	_, err := provider.Lookup(context.Background(), PublicIdentifier{Symbol: "IBM"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "quote unavailable")
}

func TestPublicIdentifierRejectsControlCharacters(t *testing.T) {
	_, err := (PublicIdentifier{Symbol: "AAPL\nX"}).Normalize()
	assert.ErrorIs(t, err, ErrInvalidIdentifier)
}

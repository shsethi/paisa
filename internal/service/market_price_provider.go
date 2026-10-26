package service

// This file contains the local-first public market-price boundary used by the
// new dashboard work. It deliberately does not accept holdings, quantities,
// account names, or invested amounts. Callers must explicitly invoke Refresh;
// Get only reads the local cache.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/shopspring/decimal"
)

var (
	ErrUnsupportedIdentifier = errors.New("market-price identifier is unsupported")
	ErrInvalidIdentifier     = errors.New("market-price identifier is invalid")
	marketSymbolPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`)
	marketExchangePattern    = regexp.MustCompile(`^[A-Za-z0-9._-]{0,24}$`)
	marketTypePattern        = regexp.MustCompile(`^[A-Za-z0-9_]{0,24}$`)
)

// PublicInstrumentType narrows the instrument classes accepted by a provider.
// The value is descriptive public metadata; it is never a holding/account
// identifier.
type PublicInstrumentType string

const (
	InstrumentStock      PublicInstrumentType = "stock"
	InstrumentETF        PublicInstrumentType = "etf"
	InstrumentFund       PublicInstrumentType = "fund"
	InstrumentMutualFund PublicInstrumentType = "mutual_fund"
)

// PublicIdentifier is the complete request passed to an external price
// provider. Keep this type intentionally small: no quantity, account, cost,
// balance, or other private holding field can be sent by this API.
type PublicIdentifier struct {
	Symbol    string               `json:"symbol"`
	Exchange  string               `json:"exchange,omitempty"`
	AssetType PublicInstrumentType `json:"asset_type,omitempty"`
}

func (id PublicIdentifier) Normalize() (PublicIdentifier, error) {
	id.Symbol = strings.TrimSpace(id.Symbol)
	id.Exchange = strings.TrimSpace(id.Exchange)
	id.AssetType = PublicInstrumentType(strings.ToLower(strings.TrimSpace(string(id.AssetType))))
	if id.Symbol == "" {
		return PublicIdentifier{}, fmt.Errorf("%w: symbol is required", ErrInvalidIdentifier)
	}
	if !marketSymbolPattern.MatchString(id.Symbol) || !marketExchangePattern.MatchString(id.Exchange) || !marketTypePattern.MatchString(string(id.AssetType)) {
		return PublicIdentifier{}, fmt.Errorf("%w: only compact public ticker, exchange, and asset type identifiers are allowed", ErrInvalidIdentifier)
	}
	for _, r := range id.Symbol + id.Exchange + string(id.AssetType) {
		if unicode.IsControl(r) {
			return PublicIdentifier{}, fmt.Errorf("%w: control characters are not allowed", ErrInvalidIdentifier)
		}
	}
	id.Symbol = strings.ToUpper(id.Symbol)
	id.Exchange = strings.ToUpper(id.Exchange)
	return id, nil
}

func (id PublicIdentifier) Key() string {
	normalized, err := id.Normalize()
	if err != nil {
		return ""
	}
	return normalized.Symbol + "@" + normalized.Exchange + "#" + string(normalized.AssetType)
}

// PublicQuote is the provider response. AsOf is the provider's quote date;
// RefreshedAt is assigned locally when the cache accepts the response.
type PublicQuote struct {
	Identifier PublicIdentifier
	Value      decimal.Decimal
	Currency   string
	AsOf       time.Time
	Source     string
	SourceURL  string
}

// PublicPriceProvider may look up only a PublicIdentifier. Implementations
// must not infer or request any private holding data.
type PublicPriceProvider interface {
	Name() string
	Supports(PublicIdentifier) bool
	Lookup(context.Context, PublicIdentifier) (PublicQuote, error)
}

// CachedPrice is local derived data. Provider and source metadata are retained
// so the UI can explain where and when the displayed value came from.
type CachedPrice struct {
	Identifier  PublicIdentifier `json:"identifier"`
	Value       decimal.Decimal  `json:"value"`
	Currency    string           `json:"currency"`
	AsOf        time.Time        `json:"as_of"`
	RefreshedAt time.Time        `json:"refreshed_at"`
	Provider    string           `json:"provider"`
	Source      string           `json:"source"`
	SourceURL   string           `json:"source_url"`
}

// PriceCache is a process-safe local cache. With NewPriceCache it is memory
// local; OpenPriceCache adds an on-disk JSON file owned by the local app.
type PriceCache struct {
	mu      sync.RWMutex
	path    string
	entries map[string]CachedPrice
}

func NewPriceCache() *PriceCache {
	return &PriceCache{entries: make(map[string]CachedPrice)}
}

func OpenPriceCache(path string) (*PriceCache, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("price cache path is required")
	}
	cache := &PriceCache{path: path, entries: make(map[string]CachedPrice)}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return cache, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read price cache: %w", err)
	}
	var entries map[string]CachedPrice
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, fmt.Errorf("decode price cache: %w", err)
	}
	for key, value := range entries {
		cache.entries[key] = value
	}
	return cache, nil
}

func (c *PriceCache) Get(id PublicIdentifier) (CachedPrice, bool) {
	key := id.Key()
	if key == "" {
		return CachedPrice{}, false
	}
	c.mu.RLock()
	value, ok := c.entries[key]
	c.mu.RUnlock()
	return value, ok
}

// List returns cached public quotes in stable key order for a local-only view.
func (c *PriceCache) List() []CachedPrice {
	if c == nil {
		return nil
	}
	c.mu.RLock()
	values := make([]CachedPrice, 0, len(c.entries))
	for _, value := range c.entries {
		values = append(values, value)
	}
	c.mu.RUnlock()
	sort.Slice(values, func(i, j int) bool { return values[i].Identifier.Key() < values[j].Identifier.Key() })
	return values
}

// Refresh is the only method that talks to a provider. A failed refresh
// returns the previous value (when present) and leaves the cache unchanged.
// An unsupported identifier is never written as a zero/empty quote.
func (c *PriceCache) Refresh(ctx context.Context, provider PublicPriceProvider, id PublicIdentifier) (CachedPrice, error) {
	if c == nil || provider == nil {
		return CachedPrice{}, errors.New("price cache and provider are required")
	}
	normalized, err := id.Normalize()
	if err != nil {
		return CachedPrice{}, err
	}
	previous, hasPrevious := c.Get(normalized)
	if !provider.Supports(normalized) {
		if hasPrevious {
			return previous, ErrUnsupportedIdentifier
		}
		return CachedPrice{}, ErrUnsupportedIdentifier
	}
	quote, err := provider.Lookup(ctx, normalized)
	if err != nil {
		if hasPrevious {
			return previous, err
		}
		return CachedPrice{}, err
	}
	quoteCurrency := strings.ToUpper(strings.TrimSpace(quote.Currency))
	if quote.Value.IsNegative() || quoteCurrency == "" || quote.AsOf.IsZero() {
		if hasPrevious {
			return previous, errors.New("provider returned an incomplete quote")
		}
		return CachedPrice{}, errors.New("provider returned an incomplete quote")
	}
	if quote.Source == "" {
		quote.Source = provider.Name()
	}
	if quote.Identifier.Symbol != "" {
		providerID, normalizeErr := quote.Identifier.Normalize()
		if normalizeErr != nil || providerID.Key() != normalized.Key() {
			if hasPrevious {
				return previous, errors.New("provider returned a mismatched identifier")
			}
			return CachedPrice{}, errors.New("provider returned a mismatched identifier")
		}
	}
	value := CachedPrice{
		Identifier:  normalized,
		Value:       quote.Value,
		Currency:    quoteCurrency,
		AsOf:        quote.AsOf.UTC(),
		RefreshedAt: time.Now().UTC(),
		Provider:    provider.Name(),
		Source:      quote.Source,
		SourceURL:   quote.SourceURL,
	}
	if err := c.put(value); err != nil {
		if hasPrevious {
			return previous, err
		}
		return CachedPrice{}, err
	}
	return value, nil
}

func (c *PriceCache) put(value CachedPrice) error {
	key := value.Identifier.Key()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.path == "" {
		if c.entries == nil {
			c.entries = make(map[string]CachedPrice)
		}
		c.entries[key] = value
		return nil
	}
	entries := make(map[string]CachedPrice, len(c.entries)+1)
	for existingKey, existingValue := range c.entries {
		entries[existingKey] = existingValue
	}
	entries[key] = value
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return fmt.Errorf("encode price cache: %w", err)
	}
	dir := filepath.Dir(c.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create price cache directory: %w", err)
	}
	temp, err := os.CreateTemp(dir, ".price-cache-*")
	if err != nil {
		return fmt.Errorf("create price cache temporary file: %w", err)
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return fmt.Errorf("protect price cache: %w", err)
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return fmt.Errorf("write price cache: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close price cache: %w", err)
	}
	if err := os.Rename(tempName, c.path); err != nil {
		return fmt.Errorf("replace price cache: %w", err)
	}
	c.entries = entries
	return nil
}

// AlphaVantageProvider implements the documented GLOBAL_QUOTE endpoint. Its
// quote currency is configured by the caller because GLOBAL_QUOTE does not
// include a currency field; no implicit FX conversion is performed.
type AlphaVantageProvider struct {
	APIKey   string
	Currency string
	BaseURL  string
	Client   *http.Client
}

func NewAlphaVantageProvider(apiKey string, currency ...string) *AlphaVantageProvider {
	quoteCurrency := "USD"
	if len(currency) > 0 && strings.TrimSpace(currency[0]) != "" {
		quoteCurrency = strings.ToUpper(strings.TrimSpace(currency[0]))
	}
	return &AlphaVantageProvider{
		APIKey:   apiKey,
		Currency: quoteCurrency,
		BaseURL:  "https://www.alphavantage.co/query",
		Client:   http.DefaultClient,
	}
}

func (p *AlphaVantageProvider) Name() string { return "Alpha Vantage GLOBAL_QUOTE" }

func (p *AlphaVantageProvider) Supports(id PublicIdentifier) bool {
	normalized, err := id.Normalize()
	if err != nil {
		return false
	}
	switch normalized.AssetType {
	case "", InstrumentStock, InstrumentETF:
		return true
	default:
		return false
	}
}

func (p *AlphaVantageProvider) Lookup(ctx context.Context, id PublicIdentifier) (PublicQuote, error) {
	normalized, err := id.Normalize()
	if err != nil {
		return PublicQuote{}, err
	}
	if !p.Supports(normalized) {
		return PublicQuote{}, ErrUnsupportedIdentifier
	}
	if strings.TrimSpace(p.APIKey) == "" {
		return PublicQuote{}, errors.New("Alpha Vantage API key is required")
	}
	if strings.TrimSpace(p.Currency) == "" {
		return PublicQuote{}, errors.New("Alpha Vantage quote currency is required")
	}
	endpoint := p.BaseURL
	if strings.TrimSpace(endpoint) == "" {
		endpoint = "https://www.alphavantage.co/query"
	}
	query := url.Values{}
	query.Set("function", "GLOBAL_QUOTE")
	query.Set("symbol", normalized.Symbol)
	query.Set("apikey", p.APIKey)
	requestURL := endpoint + "?" + query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return PublicQuote{}, err
	}
	client := p.Client
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return PublicQuote{}, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return PublicQuote{}, err
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return PublicQuote{}, fmt.Errorf("Alpha Vantage returned HTTP %d", response.StatusCode)
	}
	var payload struct {
		GlobalQuote map[string]string `json:"Global Quote"`
		Note        string            `json:"Note"`
		Information string            `json:"Information"`
		Error       string            `json:"Error Message"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return PublicQuote{}, fmt.Errorf("decode Alpha Vantage quote: %w", err)
	}
	if payload.Note != "" || payload.Information != "" || payload.Error != "" {
		message := payload.Note
		if message == "" {
			message = payload.Information
		}
		if message == "" {
			message = payload.Error
		}
		return PublicQuote{}, fmt.Errorf("Alpha Vantage quote unavailable: %s", message)
	}
	priceText := payload.GlobalQuote["05. price"]
	price, err := decimal.NewFromString(priceText)
	if err != nil || price.IsNegative() {
		return PublicQuote{}, errors.New("Alpha Vantage returned an invalid quote price")
	}
	dateText := payload.GlobalQuote["07. latest trading day"]
	asOf, err := time.Parse("2006-01-02", dateText)
	if err != nil {
		return PublicQuote{}, errors.New("Alpha Vantage returned an invalid quote date")
	}
	// The source URL intentionally excludes the API key before it is stored.
	sourceURL := endpoint + "?function=GLOBAL_QUOTE&symbol=" + url.QueryEscape(normalized.Symbol)
	return PublicQuote{
		Identifier: normalized,
		Value:      price,
		Currency:   strings.ToUpper(strings.TrimSpace(p.Currency)),
		AsOf:       asOf.UTC(),
		Source:     "Alpha Vantage GLOBAL_QUOTE",
		SourceURL:  sourceURL,
	}, nil
}

package server

// HTTP boundaries for the local-first public market-price cache.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/ananthakumaran/paisa/internal/financepaths"
	"github.com/ananthakumaran/paisa/internal/service"
	"github.com/gin-gonic/gin"
)

const (
	alphaVantageAPIKeyEnv = "ALPHAVANTAGE_API_KEY"
	alphaVantageBaseEnv   = "ALPHAVANTAGE_BASE_URL"
	alphaVantageCurrency  = "ALPHAVANTAGE_CURRENCY"
)

var publicPriceCacheMu sync.Mutex

// PublicPriceRequest is deliberately limited to public instrument metadata.
// Do not add units, account names, balances, cost basis, or other holding
// fields here: this request is allowed to cross the provider boundary.
type PublicPriceRequest struct {
	Symbol    string                       `json:"symbol" form:"symbol"`
	Exchange  string                       `json:"exchange,omitempty" form:"exchange"`
	AssetType service.PublicInstrumentType `json:"asset_type,omitempty" form:"asset_type"`
}

func (r PublicPriceRequest) identifier() (service.PublicIdentifier, error) {
	return (service.PublicIdentifier{
		Symbol: r.Symbol, Exchange: r.Exchange, AssetType: r.AssetType,
	}).Normalize()
}

func publicPriceCache() (*service.PriceCache, error) {
	paths, err := financepaths.Resolve(os.Getenv("PAISA_FINANCE_ROOT"))
	if err != nil {
		return nil, err
	}
	return service.OpenPriceCache(filepath.Join(paths.Extracted, "cache", "public-market-prices.json"))
}

func alphaVantageProvider() *service.AlphaVantageProvider {
	currency := strings.TrimSpace(os.Getenv(alphaVantageCurrency))
	provider := service.NewAlphaVantageProvider(os.Getenv(alphaVantageAPIKeyEnv), currency)
	if base := strings.TrimSpace(os.Getenv(alphaVantageBaseEnv)); base != "" {
		provider.BaseURL = base
	}
	return provider
}

func publicPriceProviderConfigured() bool {
	return strings.TrimSpace(os.Getenv(alphaVantageAPIKeyEnv)) != ""
}

func publicPriceError(c *gin.Context, status int, code string, err error, previous service.CachedPrice, hasPrevious bool) {
	body := gin.H{"code": code, "error": err.Error()}
	if hasPrevious {
		body["price"] = previous
	}
	c.JSON(status, body)
}

func decodePublicPriceJSON(c *gin.Context) (PublicPriceRequest, error) {
	var request PublicPriceRequest
	decoder := json.NewDecoder(io.LimitReader(c.Request.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return PublicPriceRequest{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return PublicPriceRequest{}, errors.New("request body must contain one JSON object")
		}
		return PublicPriceRequest{}, err
	}
	return request, nil
}

func decodePublicPriceQuery(c *gin.Context) (PublicPriceRequest, error) {
	allowed := map[string]bool{"symbol": true, "exchange": true, "asset_type": true}
	for key := range c.Request.URL.Query() {
		if !allowed[key] {
			return PublicPriceRequest{}, fmt.Errorf("unknown query field %q", key)
		}
	}
	return PublicPriceRequest{
		Symbol: c.Query("symbol"), Exchange: c.Query("exchange"), AssetType: service.PublicInstrumentType(c.Query("asset_type")),
	}, nil
}

// GetPublicMarketPrice serves only the local cache. It never constructs a
// network request and does not require an Alpha Vantage API key.
func GetPublicMarketPrice(c *gin.Context) {
	publicPriceCacheMu.Lock()
	defer publicPriceCacheMu.Unlock()
	cache, err := publicPriceCache()
	if err != nil {
		publicPriceError(c, http.StatusInternalServerError, "cache_unavailable", err, service.CachedPrice{}, false)
		return
	}
	if len(c.Request.URL.Query()) == 0 {
		c.JSON(http.StatusOK, gin.H{"prices": cache.List()})
		return
	}
	request, err := decodePublicPriceQuery(c)
	if err != nil {
		publicPriceError(c, http.StatusBadRequest, "invalid_request", err, service.CachedPrice{}, false)
		return
	}
	identifier, err := request.identifier()
	if err != nil {
		publicPriceError(c, http.StatusBadRequest, "invalid_identifier", err, service.CachedPrice{}, false)
		return
	}
	provider := alphaVantageProvider()
	if !provider.Supports(identifier) {
		publicPriceError(c, http.StatusUnprocessableEntity, "unsupported_instrument", service.ErrUnsupportedIdentifier, service.CachedPrice{}, false)
		return
	}
	value, ok := cache.Get(identifier)
	if !ok {
		publicPriceError(c, http.StatusNotFound, "not_cached", errors.New("no local quote; use the explicit refresh endpoint"), service.CachedPrice{}, false)
		return
	}
	c.JSON(http.StatusOK, gin.H{"price": value})
}

// RefreshPublicMarketPrice performs the only provider-backed operation. It
// returns a previous cached quote alongside an error when a refresh fails.
func RefreshPublicMarketPrice(c *gin.Context) {
	request, err := decodePublicPriceJSON(c)
	if err != nil {
		publicPriceError(c, http.StatusBadRequest, "invalid_request", err, service.CachedPrice{}, false)
		return
	}
	identifier, err := request.identifier()
	if err != nil {
		publicPriceError(c, http.StatusBadRequest, "invalid_identifier", err, service.CachedPrice{}, false)
		return
	}
	publicPriceCacheMu.Lock()
	defer publicPriceCacheMu.Unlock()
	cache, err := publicPriceCache()
	if err != nil {
		publicPriceError(c, http.StatusInternalServerError, "cache_unavailable", err, service.CachedPrice{}, false)
		return
	}
	previous, hasPrevious := cache.Get(identifier)
	provider := alphaVantageProvider()
	if !provider.Supports(identifier) {
		publicPriceError(c, http.StatusUnprocessableEntity, "unsupported_instrument", service.ErrUnsupportedIdentifier, previous, hasPrevious)
		return
	}
	if !publicPriceProviderConfigured() {
		publicPriceError(c, http.StatusServiceUnavailable, "provider_not_configured", errors.New("Alpha Vantage provider is not configured; set ALPHAVANTAGE_API_KEY"), previous, hasPrevious)
		return
	}
	value, err := cache.Refresh(c.Request.Context(), provider, identifier)
	if err != nil {
		publicPriceError(c, http.StatusBadGateway, "provider_refresh_failed", err, value, hasPrevious)
		return
	}
	c.JSON(http.StatusOK, gin.H{"price": value, "refreshed": true})
}

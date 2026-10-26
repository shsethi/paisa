package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func publicPriceRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/api/price/public", GetPublicMarketPrice)
	router.POST("/api/price/public/refresh", RefreshPublicMarketPrice)
	return router
}

func TestGetPublicMarketPriceReadsLocalCacheOnly(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PAISA_FINANCE_ROOT", root)
	t.Setenv(alphaVantageAPIKeyEnv, "")
	called := false
	oldClient := http.DefaultClient
	http.DefaultClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		called = true
		return nil, io.ErrUnexpectedEOF
	})}
	t.Cleanup(func() { http.DefaultClient = oldClient })

	request := httptest.NewRequest(http.MethodGet, "/api/price/public?symbol=IBM&asset_type=stock", nil)
	response := httptest.NewRecorder()
	publicPriceRouter().ServeHTTP(response, request)
	if response.Code != http.StatusNotFound || called {
		t.Fatalf("expected local cache miss without network, status=%d network=%v body=%s", response.Code, called, response.Body.String())
	}
}

func TestRefreshPublicMarketPriceRejectsPrivateFieldsAndUnsupportedTypes(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PAISA_FINANCE_ROOT", root)
	t.Setenv(alphaVantageAPIKeyEnv, "key")
	router := publicPriceRouter()

	privateRequest := httptest.NewRequest(http.MethodPost, "/api/price/public/refresh", strings.NewReader(`{"symbol":"IBM","units":"1"}`))
	privateResponse := httptest.NewRecorder()
	router.ServeHTTP(privateResponse, privateRequest)
	if privateResponse.Code != http.StatusBadRequest {
		t.Fatalf("expected unknown private field to be rejected, got %d: %s", privateResponse.Code, privateResponse.Body.String())
	}

	unsupportedRequest := httptest.NewRequest(http.MethodPost, "/api/price/public/refresh", strings.NewReader(`{"symbol":"BTCUSD","asset_type":"crypto"}`))
	unsupportedResponse := httptest.NewRecorder()
	router.ServeHTTP(unsupportedResponse, unsupportedRequest)
	if unsupportedResponse.Code != http.StatusUnprocessableEntity || !strings.Contains(unsupportedResponse.Body.String(), "unsupported_instrument") {
		t.Fatalf("expected clear unsupported error, got %d: %s", unsupportedResponse.Code, unsupportedResponse.Body.String())
	}
}

func TestRefreshPublicMarketPriceUsesAlphaVantageAndPreservesPriorQuote(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PAISA_FINANCE_ROOT", root)
	t.Setenv(alphaVantageAPIKeyEnv, "test-key")
	t.Setenv(alphaVantageCurrency, "USD")
	requests := 0
	oldClient := http.DefaultClient
	http.DefaultClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		if request.URL.Query().Get("symbol") != "IBM" || request.URL.Query().Get("function") != "GLOBAL_QUOTE" || request.URL.Query().Get("apikey") != "test-key" {
			t.Fatalf("unexpected public provider request: %s", request.URL.String())
		}
		if requests == 1 {
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"Global Quote":{"05. price":"222.10","07. latest trading day":"2026-10-23"}}`)), Header: make(http.Header), Request: request}, nil
		}
		return &http.Response{StatusCode: http.StatusBadGateway, Body: io.NopCloser(strings.NewReader("upstream failure")), Header: make(http.Header), Request: request}, nil
	})}
	t.Cleanup(func() { http.DefaultClient = oldClient })
	t.Setenv(alphaVantageBaseEnv, "https://provider.invalid/query")
	router := publicPriceRouter()

	firstRequest := httptest.NewRequest(http.MethodPost, "/api/price/public/refresh", strings.NewReader(`{"symbol":"ibm","asset_type":"stock"}`))
	firstResponse := httptest.NewRecorder()
	router.ServeHTTP(firstResponse, firstRequest)
	if firstResponse.Code != http.StatusOK {
		t.Fatalf("expected first refresh success, got %d: %s", firstResponse.Code, firstResponse.Body.String())
	}

	secondRequest := httptest.NewRequest(http.MethodPost, "/api/price/public/refresh", strings.NewReader(`{"symbol":"IBM","asset_type":"stock"}`))
	secondResponse := httptest.NewRecorder()
	router.ServeHTTP(secondResponse, secondRequest)
	if secondResponse.Code != http.StatusBadGateway || !strings.Contains(secondResponse.Body.String(), "provider_refresh_failed") || !strings.Contains(secondResponse.Body.String(), "222.1") {
		t.Fatalf("expected prior quote with refresh error, got %d: %s", secondResponse.Code, secondResponse.Body.String())
	}

	var payload map[string]any
	if err := json.Unmarshal(secondResponse.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["price"] == nil {
		t.Fatalf("failed refresh discarded prior quote: %s", secondResponse.Body.String())
	}
	if requests != 2 {
		t.Fatalf("expected two explicit upstream refreshes, got %d", requests)
	}
}

func TestRefreshPublicMarketPriceReportsMissingConfiguration(t *testing.T) {
	t.Setenv("PAISA_FINANCE_ROOT", t.TempDir())
	t.Setenv(alphaVantageAPIKeyEnv, "")
	request := httptest.NewRequest(http.MethodPost, "/api/price/public/refresh", strings.NewReader(`{"symbol":"IBM"}`))
	response := httptest.NewRecorder()
	publicPriceRouter().ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "provider_not_configured") {
		t.Fatalf("expected not-configured error, got %d: %s", response.Code, response.Body.String())
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }
